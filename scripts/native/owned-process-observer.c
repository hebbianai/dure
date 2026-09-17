#include <ctype.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define DURE_PROC_PIDUNIQIDENTIFIERINFO 17
/* 4096이었을 때 콜드 cargo 빌드(663 crate)가 smoke의 tauri dev 체인 아래서
 * 수천 개의 단명 rustc/cc PID를 만들어 한도를 넘겼다 — 슬롯은 고유 PID마다
 * 영구 점유되므로(활성 여부 무관) 한도는 "동시" 프로세스가 아니라 "누적"
 * 고유 PID 수를 바운드한다. 기능 검증이 통과한 run이 cleanup 관찰자 사망
 * (exit 8)으로 red가 되는 사고가 2026-08-01 CI run 30700491314에서 실측됨
 * (hebbian-frontend-q2ie). 프로덕션 빌드는 Node ledger와 같은 상한을
 * -D로 주입한다. 아래 값은 독립 컴파일용 fallback이다. 32768 × 24B ≈
 * 786KB로 콜드 풀빌드에도 여유가 크고, 진짜 폭주 트리는 여전히
 * fail-closed로 잡는다. */
#ifndef MAX_OWNED_PROCESSES
#define MAX_OWNED_PROCESSES 32768
#endif
#define CHILD_CENSUS_CAPACITY (MAX_OWNED_PROCESSES + 1)
#define MAX_PROCESS_CENSUS_MEMBERS 1000000
#define PROCESS_CENSUS_ATTEMPTS 4
#define PROCESS_CENSUS_SLACK 256
#define MAX_EVENTS 64
#define EXACT_BSD_INFO_ATTEMPTS 200
#define EXACT_BSD_INFO_RETRY_USEC 10000
#define BOOT_SESSION_UUID_LENGTH 36
#define BOOT_SESSION_UUID_SIZE (BOOT_SESSION_UUID_LENGTH + 1)
#define EXACT_MEMBER_METADATA_UNAVAILABLE 19

struct dure_proc_uniqidentifierinfo {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  int32_t p_orig_ppidversion;
  uint64_t p_reserve2;
  uint64_t p_reserve3;
};

_Static_assert(sizeof(struct dure_proc_uniqidentifierinfo) == 56,
               "unexpected proc unique identifier ABI");

struct watched_process {
  pid_t pid;
  uint64_t uniqueid;
  pid_t proven_parent_pid;
  uint64_t proven_parent_uniqueid;
  int active;
  int metadata_emitted;
};

struct observer {
  int kqueue_fd;
  struct watched_process processes[MAX_OWNED_PROCESSES];
  size_t process_count;
  size_t emitted_process_count;
};

#ifdef DURE_OWNERSHIP_OBSERVER_FAULT_INJECTION
static int observer_barrier_completed_for_faults = 0;

static int fault_enabled(const char *name) {
  const char *fault = getenv("DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT");
  return fault && strcmp(fault, name) == 0;
}
#else
static int fault_enabled(const char *name) {
  (void)name;
  return 0;
}
#endif

static uint64_t monotonic_nanoseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
}

static uint64_t realtime_nanoseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
}

static uint64_t timeval_microseconds(struct timeval value) {
  return (uint64_t)value.tv_sec * 1000000ULL + (uint64_t)value.tv_usec;
}

static int normalize_boot_session_uuid(
    const char *value, char result[BOOT_SESSION_UUID_SIZE]) {
  if (!value || strlen(value) != BOOT_SESSION_UUID_LENGTH) return 2;
  for (size_t index = 0; index < BOOT_SESSION_UUID_LENGTH; index++) {
    int separator = index == 8 || index == 13 || index == 18 || index == 23;
    unsigned char character = (unsigned char)value[index];
    if ((separator && character != '-') ||
        (!separator && !isxdigit(character))) {
      return 2;
    }
    result[index] = separator ? '-' : (char)tolower(character);
  }
  result[BOOT_SESSION_UUID_LENGTH] = '\0';
  return 0;
}

static int read_boot_session_uuid(char result[BOOT_SESSION_UUID_SIZE]) {
  char raw[64];
  size_t size = sizeof(raw);
  if (sysctlbyname("kern.bootsessionuuid", raw, &size, NULL, 0) != 0 ||
      size == 0 || size > sizeof(raw)) {
    fprintf(stderr, "kern.bootsessionuuid unavailable errno=%d\n", errno);
    return 15;
  }
  size_t length = raw[size - 1] == '\0' ? size - 1 : size;
  if (length != BOOT_SESSION_UUID_LENGTH) return 15;
  raw[length] = '\0';
  return normalize_boot_session_uuid(raw, result) == 0 ? 0 : 15;
}

static int require_boot_session(const char *expected) {
  char normalized[BOOT_SESSION_UUID_SIZE];
  int status = normalize_boot_session_uuid(expected, normalized);
  if (status != 0) return status;
  char current[BOOT_SESSION_UUID_SIZE];
  status = read_boot_session_uuid(current);
  if (status != 0) return status;
  return strcmp(normalized, current) == 0 ? 0 : 4;
}

static int emit_runtime_metrics(const struct observer *observer,
                                uint64_t started_at_ns,
                                const struct rusage *started_usage) {
  uint64_t finished_at_ns = monotonic_nanoseconds();
  struct rusage finished_usage;
  int usage_status = getrusage(RUSAGE_SELF, &finished_usage);
  if (finished_at_ns <= started_at_ns || usage_status != 0) {
    fprintf(stderr,
            "observer runtime metrics unavailable started_ns=%llu "
            "finished_ns=%llu getrusage=%d errno=%d\n",
            (unsigned long long)started_at_ns,
            (unsigned long long)finished_at_ns, usage_status, errno);
    return 15;
  }
  uint64_t started_cpu_us =
      timeval_microseconds(started_usage->ru_utime) +
      timeval_microseconds(started_usage->ru_stime);
  uint64_t finished_cpu_us =
      timeval_microseconds(finished_usage.ru_utime) +
      timeval_microseconds(finished_usage.ru_stime);
  if (finished_cpu_us < started_cpu_us) {
    fprintf(stderr,
            "observer runtime cpu regressed started_us=%llu finished_us=%llu\n",
            (unsigned long long)started_cpu_us,
            (unsigned long long)finished_cpu_us);
    return 15;
  }
  fprintf(stderr,
          "dure_observer_metrics_v1 wall_ns=%llu cpu_us=%llu emitted=%zu\n",
          (unsigned long long)(finished_at_ns - started_at_ns),
          (unsigned long long)(finished_cpu_us - started_cpu_us),
          observer->emitted_process_count);
  return fflush(stderr) == 0 ? 0 : 10;
}

static int read_identity(pid_t pid,
                         struct dure_proc_uniqidentifierinfo *info) {
#ifdef DURE_OWNERSHIP_OBSERVER_FAULT_INJECTION
  if (fault_enabled("identity-esrch")) return 3;
  if (fault_enabled("identity-eperm") || fault_enabled("identity-eio")) {
    int injected_errno = fault_enabled("identity-eperm") ? EPERM : EIO;
    fprintf(stderr, "injected proc_pidinfo pid=%ld errno=%d\n", (long)pid,
            injected_errno);
    return 5;
  }
#endif
  for (int attempt = 0; attempt < 3; attempt++) {
    errno = 0;
    int size = proc_pidinfo(pid, DURE_PROC_PIDUNIQIDENTIFIERINFO, 0, info,
                            (int)sizeof(*info));
    int saved_errno = errno;
    if (size == (int)sizeof(*info)) return 0;
    if (size == 0 && saved_errno == ESRCH) return 3;
    if (attempt < 2 &&
        (saved_errno == EINTR || saved_errno == EAGAIN ||
         saved_errno == ENOMEM || saved_errno == EPERM)) {
      usleep((useconds_t)(1000 * (attempt + 1)));
      continue;
    }
    fprintf(stderr, "proc_pidinfo pid=%ld size=%d errno=%d\n", (long)pid,
            size, saved_errno);
    return 5;
  }
  return 5;
}

static int read_bsd_info(pid_t pid, struct proc_bsdinfo *info) {
#ifdef DURE_OWNERSHIP_OBSERVER_FAULT_INJECTION
  if (fault_enabled("bsd-eperm") ||
      (fault_enabled("bsd-eperm-after-barrier") &&
       observer_barrier_completed_for_faults)) {
    fprintf(stderr, "injected proc_bsdinfo pid=%ld errno=%d\n", (long)pid,
            EPERM);
    return 15;
  }
#endif
  for (int attempt = 0; attempt < 3; attempt++) {
    errno = 0;
    int size =
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof(*info));
    int saved_errno = errno;
    if (size == (int)sizeof(*info)) return 0;
    if (size == 0 && saved_errno == ESRCH) return 3;
    if (attempt < 2 &&
        (saved_errno == EINTR || saved_errno == EAGAIN ||
         saved_errno == ENOMEM || saved_errno == EPERM)) {
      usleep((useconds_t)(1000 * (attempt + 1)));
      continue;
    }
    fprintf(stderr, "proc_bsdinfo pid=%ld size=%d errno=%d\n", (long)pid,
            size, saved_errno);
    return 15;
  }
  return 15;
}

static int read_exact_bsd_info(pid_t pid, uint64_t expected_uniqueid,
                               struct proc_bsdinfo *info) {
  int failure_status = 15;
  /*
   * libproc can expose PROC_PIDUNIQIDENTIFIERINFO before PROC_PIDTBSDINFO for
   * a newly forked process.  Under host-wide process churn that split view has
   * lasted longer than the old 250 ms budget.  Never translate it to absence:
   * the unique id still names a live generation and dropping it would weaken
   * the ownership fence.  Keep retrying for a bounded two seconds, then fail
   * closed so the supervisor can tear down the already-proven owned tree.
   */
  for (int attempt = 0; attempt < EXACT_BSD_INFO_ATTEMPTS; attempt++) {
    int bsd_status = read_bsd_info(pid, info);
    if (bsd_status != 0) failure_status = bsd_status;
    struct dure_proc_uniqidentifierinfo identity;
    int identity_status = read_identity(pid, &identity);
    if (identity_status == 3 ||
        (identity_status == 0 && identity.p_uniqueid != expected_uniqueid)) {
      return 3;
    }
    if (identity_status == 0 && bsd_status == 0) return 0;
    if (identity_status != 0) failure_status = identity_status;
    if (attempt < EXACT_BSD_INFO_ATTEMPTS - 1)
      usleep(EXACT_BSD_INFO_RETRY_USEC);
  }
  fprintf(stderr, "exact bsd identity remained unavailable pid=%ld\n",
          (long)pid);
  return failure_status;
}

static int signal_identity(pid_t pid, uint64_t expected_uniqueid,
                           int signal_number) {
  for (int attempt = 0; attempt < 3; attempt++) {
    struct dure_proc_uniqidentifierinfo info;
    int status = read_identity(pid, &info);
    if (status != 0) return status;
    if (info.p_uniqueid != expected_uniqueid) return 4;

    audit_token_t token = INVALID_AUDIT_TOKEN_VALUE;
    token.val[5] = (unsigned int)pid;
    token.val[7] = (unsigned int)info.p_idversion;
    int error = proc_signal_with_audittoken(&token, signal_number);
    if (error == 0) return 0;
    if (error == ESRCH) continue;
    fprintf(stderr, "proc_signal_with_audittoken pid=%ld errno=%d\n",
            (long)pid, error);
    return 6;
  }
  fprintf(stderr, "process identity kept changing during signal pid=%ld\n",
          (long)pid);
  return 5;
}

static int identity_is_stopped(pid_t pid, uint64_t expected_uniqueid) {
  struct proc_bsdinfo info;
  int status = read_exact_bsd_info(pid, expected_uniqueid, &info);
  if (status != 0) return status;
  return info.pbi_status == SSTOP || info.pbi_status == SZOMB ? 0 : 7;
}

static struct watched_process *watched_at_pid(struct observer *observer,
                                               pid_t pid) {
  for (size_t index = 0; index < observer->process_count; index++) {
    if (observer->processes[index].pid == pid) {
      return &observer->processes[index];
    }
  }
  return NULL;
}

static struct watched_process *watched_at_uniqueid(struct observer *observer,
                                                    uint64_t uniqueid) {
  for (size_t index = 0; index < observer->process_count; index++) {
    if (observer->processes[index].uniqueid == uniqueid) {
      return &observer->processes[index];
    }
  }
  return NULL;
}

static int scan_children(struct observer *observer, pid_t parent_pid,
                         uint64_t parent_uniqueid);
static int read_exact_member_for_watch(
    pid_t pid, struct dure_proc_uniqidentifierinfo *identity,
    struct proc_bsdinfo *bsd, pid_t *session_id);

static int watch_metadata_status(pid_t pid, uint64_t expected_uniqueid) {
  struct dure_proc_uniqidentifierinfo current;
  int status = read_identity(pid, &current);
  if (status != 0) return status;
  return current.p_uniqueid == expected_uniqueid
             ? EXACT_MEMBER_METADATA_UNAVAILABLE
             : 3;
}

static int promote_watched_process(struct observer *observer,
                                   struct watched_process *watched) {
  if (watched->metadata_emitted) return 0;
  struct dure_proc_uniqidentifierinfo identity;
  struct proc_bsdinfo bsd;
  pid_t session_id = 0;
  int status =
      read_exact_member_for_watch(watched->pid, &identity, &bsd, &session_id);
  if (status == EXACT_MEMBER_METADATA_UNAVAILABLE) return 0;
  if (status != 0) return status;
  if (identity.p_uniqueid != watched->uniqueid) return 3;
  if (identity.p_puniqueid != watched->proven_parent_uniqueid ||
      (pid_t)bsd.pbi_ppid != watched->proven_parent_pid)
    return 0;
  /* This timestamp is telemetry only, never process identity authority.
   * CLOCK_REALTIME shares an epoch with Date.now() in the Node harness;
   * macOS Node hrtime and CLOCK_MONOTONIC can have different suspend
   * offsets even though each is monotonic on its own. */
  uint64_t emitted_at_ns = realtime_nanoseconds();
  if (emitted_at_ns == 0)
    printf("P %ld %llu %ld %llu %u %u %ld %llu\n", (long)watched->pid,
           (unsigned long long)watched->uniqueid,
           (long)watched->proven_parent_pid,
           (unsigned long long)watched->proven_parent_uniqueid, bsd.pbi_ppid,
           bsd.pbi_pgid, (long)session_id,
           (unsigned long long)bsd.pbi_start_tvsec);
  else
    printf("P %ld %llu %ld %llu %u %u %ld %llu %llu\n",
           (long)watched->pid, (unsigned long long)watched->uniqueid,
           (long)watched->proven_parent_pid,
           (unsigned long long)watched->proven_parent_uniqueid, bsd.pbi_ppid,
           bsd.pbi_pgid, (long)session_id,
           (unsigned long long)bsd.pbi_start_tvsec,
           (unsigned long long)emitted_at_ns);
  if (fflush(stdout) != 0) return 10;
  watched->metadata_emitted = 1;
  observer->emitted_process_count++;
  return 0;
}

static int watch_process(struct observer *observer, pid_t pid,
                         uint64_t uniqueid, pid_t proven_parent_pid,
                         uint64_t proven_parent_uniqueid, int emit) {
  struct dure_proc_uniqidentifierinfo identity;
  int status = read_identity(pid, &identity);
  if (status != 0) return status;
  if (identity.p_uniqueid != uniqueid) return 3;
  if (emit && identity.p_puniqueid != proven_parent_uniqueid) {
    return 3;
  }

  struct watched_process *watched = watched_at_pid(observer, pid);
  if (watched && watched->active && watched->uniqueid == uniqueid) {
    status = emit ? promote_watched_process(observer, watched) : 0;
    if (status != 0 && status != 3) return status;
    return 0;
  }
  if (!watched) {
    if (observer->process_count >= MAX_OWNED_PROCESSES) return 8;
    watched = &observer->processes[observer->process_count++];
  }
  watched->pid = pid;
  watched->uniqueid = uniqueid;
  watched->proven_parent_pid = proven_parent_pid;
  watched->proven_parent_uniqueid = proven_parent_uniqueid;
  watched->active = 1;
  watched->metadata_emitted = !emit;

  struct kevent change;
  EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR,
         NOTE_FORK | NOTE_EXIT, 0, NULL);
  if (kevent(observer->kqueue_fd, &change, 1, NULL, 0, NULL) != 0) {
    if (errno == ESRCH) {
      watched->active = 0;
      return 3;
    }
    return 9;
  }

  if (emit) {
    printf("S %ld %llu %ld %llu\n", (long)pid,
           (unsigned long long)uniqueid, (long)proven_parent_pid,
           (unsigned long long)proven_parent_uniqueid);
    if (fflush(stdout) != 0) return 10;
    status = promote_watched_process(observer, watched);
    if (status != 0 && status != 3) return status;
  }
  return scan_children(observer, pid, uniqueid);
}

static int scan_children(struct observer *observer, pid_t parent_pid,
                         uint64_t parent_uniqueid) {
  if (fault_enabled("child-census-capacity")) return 8;
  struct dure_proc_uniqidentifierinfo before;
  int status = read_identity(parent_pid, &before);
  if (status == 3) return 0;
  if (status != 0) return status;
  if (before.p_uniqueid != parent_uniqueid) return 0;

  pid_t children[CHILD_CENSUS_CAPACITY];
  errno = 0;
  int count = proc_listchildpids(parent_pid, children, (int)sizeof(children));
  if (count < 0) return errno == ESRCH ? 0 : 11;
  if (count >= CHILD_CENSUS_CAPACITY) return 8;

  struct dure_proc_uniqidentifierinfo after;
  status = read_identity(parent_pid, &after);
  if (status == 3) return 0;
  if (status != 0) return status;
  if (after.p_uniqueid != parent_uniqueid) return 0;

  for (int index = 0; index < count; index++) {
    pid_t child_pid = children[index];
    if (child_pid <= 1) continue;
    struct dure_proc_uniqidentifierinfo child_identity;
    status = read_identity(child_pid, &child_identity);
    if (status == 3) continue;
    if (status != 0) return status;
    if (child_identity.p_puniqueid != parent_uniqueid) continue;
    status = watch_process(observer, child_pid, child_identity.p_uniqueid,
                           parent_pid, parent_uniqueid, 1);
    if (status != 0 && status != 3) return status;
  }
  return 0;
}

typedef int (*pid_census_reader)(pid_t *, int);

static int read_all_pid_count(pid_t *buffer, int buffer_bytes) {
  return proc_listallpids(buffer, buffer_bytes);
}

static int read_user_pid_count(pid_t *buffer, int buffer_bytes) {
  int bytes = proc_listpids(PROC_UID_ONLY, (uint32_t)geteuid(), buffer,
                           buffer_bytes);
  if (bytes < 0) return bytes;
  if (bytes % (int)sizeof(pid_t) != 0) {
    errno = EPROTO;
    return -1;
  }
  return bytes / (int)sizeof(pid_t);
}

static int list_pids(pid_census_reader read_count, pid_t **result,
                     int *result_count) {
  if (fault_enabled("system-census-capacity")) return 8;
  errno = 0;
  int estimated = read_count(NULL, 0);
  if (estimated <= 0) {
    fprintf(stderr, "process census estimate=%d errno=%d\n", estimated,
            errno);
    return 11;
  }
  size_t capacity = (size_t)estimated;
  if (capacity > MAX_PROCESS_CENSUS_MEMBERS) return 8;
  capacity += PROCESS_CENSUS_SLACK;
  if (capacity > MAX_PROCESS_CENSUS_MEMBERS) {
    capacity = MAX_PROCESS_CENSUS_MEMBERS;
  }

  for (int attempt = 0; attempt < PROCESS_CENSUS_ATTEMPTS; attempt++) {
    if (capacity > (size_t)INT_MAX / sizeof(pid_t)) return 8;
    pid_t *candidates = calloc(capacity, sizeof(*candidates));
    if (!candidates) return 8;
    errno = 0;
    int actual =
        read_count(candidates, (int)(capacity * sizeof(*candidates)));
    int saved_errno = errno;
    if (actual < 0) {
      free(candidates);
      fprintf(stderr, "process census actual=%d errno=%d\n", actual,
              saved_errno);
      return 11;
    }
    if ((size_t)actual < capacity) {
      *result = candidates;
      *result_count = actual;
      return 0;
    }
    free(candidates);
    if (capacity == MAX_PROCESS_CENSUS_MEMBERS) break;
    capacity *= 2;
    if (capacity > MAX_PROCESS_CENSUS_MEMBERS) {
      capacity = MAX_PROCESS_CENSUS_MEMBERS;
    }
  }
  return 8;
}

static int list_all_pids(pid_t **result, int *result_count) {
  return list_pids(read_all_pid_count, result, result_count);
}

static int list_user_pids(pid_t **result, int *result_count) {
  return list_pids(read_user_pid_count, result, result_count);
}

static int list_group_pids(pid_t group_id, pid_t **result,
                           int *result_count) {
  errno = 0;
  int estimated = proc_listpgrppids((uint32_t)group_id, NULL, 0);
  int saved_errno = errno;
  if (estimated == 0 && (saved_errno == 0 || saved_errno == ESRCH)) {
    *result = NULL;
    *result_count = 0;
    return 0;
  }
  if (estimated < 0) return 11;
  size_t capacity = (size_t)estimated + PROCESS_CENSUS_SLACK;
  if (capacity > MAX_PROCESS_CENSUS_MEMBERS) return 8;
  for (int attempt = 0; attempt < PROCESS_CENSUS_ATTEMPTS; attempt++) {
    if (capacity > (size_t)INT_MAX / sizeof(pid_t)) return 8;
    pid_t *candidates = calloc(capacity, sizeof(*candidates));
    if (!candidates) return 8;
    errno = 0;
    int actual = proc_listpgrppids(
        (uint32_t)group_id, candidates,
        (int)(capacity * sizeof(*candidates)));
    saved_errno = errno;
    if (fault_enabled("group-census-saturated")) actual = (int)capacity;
    if (actual < 0) {
      free(candidates);
      return saved_errno == ESRCH ? 0 : 11;
    }
    if ((size_t)actual < capacity) {
      *result = candidates;
      *result_count = actual;
      return 0;
    }
    free(candidates);
    if (capacity == MAX_PROCESS_CENSUS_MEMBERS) break;
    capacity *= 2;
    if (capacity > MAX_PROCESS_CENSUS_MEMBERS) {
      capacity = MAX_PROCESS_CENSUS_MEMBERS;
    }
  }
  return 8;
}

static int reconcile(struct observer *observer) {
  size_t known_limit = observer->process_count;
  for (size_t index = 0; index < known_limit; index++) {
    struct watched_process *watched = &observer->processes[index];
    if (!watched->active) continue;
    int status = scan_children(observer, watched->pid, watched->uniqueid);
    if (status != 0) return status;
  }

  pid_t *candidates = NULL;
  int count = 0;
  int result = list_all_pids(&candidates, &count);
  if (result != 0) return result;
  for (size_t pass = 0; pass < MAX_OWNED_PROCESSES; pass++) {
    size_t before = observer->process_count;
    for (int index = 0; index < count; index++) {
      pid_t candidate_pid = candidates[index];
      if (candidate_pid <= 1) continue;
      struct dure_proc_uniqidentifierinfo identity;
      int status = read_identity(candidate_pid, &identity);
      if (status == 3) continue;
      if (status != 0) {
        result = status;
        goto complete;
      }
      struct watched_process *known = watched_at_pid(observer, candidate_pid);
      if (known && known->uniqueid == identity.p_uniqueid) {
        int status = promote_watched_process(observer, known);
        if (status != 0 && status != 3) {
          result = status;
          goto complete;
        }
        continue;
      }
      struct watched_process *parent =
          watched_at_uniqueid(observer, identity.p_puniqueid);
      if (!parent) continue;
      status = watch_process(observer, candidate_pid, identity.p_uniqueid,
                             parent->pid, parent->uniqueid, 1);
      if (status != 0 && status != 3) {
        result = status;
        goto complete;
      }
    }
    if (observer->process_count == before) {
      result = 0;
      goto complete;
    }
  }
  result = 8;

complete:
  free(candidates);
  return result;
}

static int process_events(struct observer *observer, struct kevent *events,
                          int count) {
  for (int index = 0; index < count; index++) {
    struct kevent *event = &events[index];
    if (event->filter != EVFILT_PROC) continue;
    pid_t pid = (pid_t)event->ident;
    struct watched_process *watched = watched_at_pid(observer, pid);
    if (!watched || !watched->active) continue;
    if ((event->fflags & NOTE_FORK) != 0) {
      size_t before = observer->process_count;
      int status = scan_children(observer, pid, watched->uniqueid);
      if (status != 0) return status;
      if (observer->process_count == before) {
        status = reconcile(observer);
        if (status != 0) return status;
      }
      if (observer->process_count == before) {
        /* Darwin deliberately withholds NOTE_FORK's child PID from the
         * userspace kevent. A short-lived child can therefore exit before
         * either census observes it. This helper is used only by macOS
         * observation mode: run-contained is rejected before command
         * admission, and observation receipts can never authorize root
         * retirement. Keep exact signalling for generations we did observe
         * without turning a lossy NOTE_FORK edge into an app-start failure. */
        continue;
      }
    }
    if ((event->fflags & NOTE_EXIT) != 0) watched->active = 0;
  }
  return 0;
}

static int drain_events(struct observer *observer) {
  struct kevent events[MAX_EVENTS];
  struct timespec immediate = {.tv_sec = 0, .tv_nsec = 0};
  for (;;) {
    int count = kevent(observer->kqueue_fd, NULL, 0, events, MAX_EVENTS,
                       &immediate);
    if (count < 0) return errno == EINTR ? 0 : 12;
    if (count == 0) return reconcile(observer);
    int status = process_events(observer, events, count);
    if (status != 0) return status;
  }
}

static int watch_identity(pid_t leader_pid, uint64_t leader_uniqueid) {
  /* 32768-슬롯 확장으로 ~786KB — 스택이 아니라 정적 저장소에 둔다.
   * watch_identity는 프로세스당 한 번만 실행된다. */
  static struct observer observer;
  uint64_t started_at_ns = monotonic_nanoseconds();
  struct rusage started_usage;
  if (started_at_ns == 0 || getrusage(RUSAGE_SELF, &started_usage) != 0) {
    return 15;
  }
  observer.kqueue_fd = kqueue();
  observer.process_count = 0;
  observer.emitted_process_count = 0;
  if (observer.kqueue_fd < 0) return 12;
  int status =
      watch_process(&observer, leader_pid, leader_uniqueid, 0, 0, 0);
  if (status != 0) return status;

  struct kevent stdin_change;
  EV_SET(&stdin_change, STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR,
         0, 0, NULL);
  if (kevent(observer.kqueue_fd, &stdin_change, 1, NULL, 0, NULL) != 0) {
    return 12;
  }
  printf("R 1\n");
  if (fflush(stdout) != 0) return 10;

  char input[256];
  struct kevent events[MAX_EVENTS];
  struct timespec reconciliation = {.tv_sec = 0, .tv_nsec = 250000000};
  for (;;) {
    int count = kevent(observer.kqueue_fd, NULL, 0, events, MAX_EVENTS,
                       &reconciliation);
    if (count < 0) {
      if (errno == EINTR) continue;
      return 12;
    }
    status = process_events(&observer, events, count);
    if (status != 0) return status;
    if (count == 0) {
      status = reconcile(&observer);
      if (status != 0) return status;
    }

    for (int index = 0; index < count; index++) {
      if (events[index].filter != EVFILT_READ ||
          events[index].ident != STDIN_FILENO) {
        continue;
      }
      ssize_t bytes = read(STDIN_FILENO, input, sizeof(input) - 1);
      if (bytes == 0) {
        return emit_runtime_metrics(&observer, started_at_ns, &started_usage);
      }
      if (bytes < 0) {
        if (errno == EINTR || errno == EAGAIN) continue;
        return 13;
      }
      input[bytes] = '\0';
      char *save = NULL;
      for (char *line = strtok_r(input, "\n", &save); line;
           line = strtok_r(NULL, "\n", &save)) {
        unsigned long long barrier = 0;
        if (sscanf(line, "barrier %llu", &barrier) == 1) {
          status = drain_events(&observer);
          if (status != 0) return status;
          printf("B %llu\n", barrier);
          if (fflush(stdout) != 0) return 10;
#ifdef DURE_OWNERSHIP_OBSERVER_FAULT_INJECTION
          observer_barrier_completed_for_faults = 1;
#endif
        } else if (strcmp(line, "stop") == 0) {
          return emit_runtime_metrics(&observer, started_at_ns,
                                      &started_usage);
        } else {
          return 14;
        }
      }
    }
  }
}

static int parse_pid(const char *value, pid_t *result) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || !end || *end || parsed <= 1 || parsed > INT32_MAX) return 2;
  *result = (pid_t)parsed;
  return 0;
}

static int parse_uniqueid(const char *value, uint64_t *result) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno || !end || *end || parsed == 0) return 2;
  *result = (uint64_t)parsed;
  return 0;
}

static const char *member_state(const struct proc_bsdinfo *info) {
  if (info->pbi_status == SZOMB) return "zombie";
  if (info->pbi_status == SSTOP) return "stopped";
  return "live";
}

static int read_exact_member_for_watch(
    pid_t pid, struct dure_proc_uniqidentifierinfo *identity,
    struct proc_bsdinfo *bsd, pid_t *session_id) {
  struct dure_proc_uniqidentifierinfo before;
  int status = read_identity(pid, &before);
  if (status != 0) return status;
  errno = 0;
  pid_t session_before = getsid(pid);
  if (session_before < 0) {
    int saved_errno = errno;
    if (saved_errno == ESRCH) return 3;
    fprintf(stderr, "observer getsid-before pid=%ld errno=%d\n", (long)pid,
            saved_errno);
    return watch_metadata_status(pid, before.p_uniqueid);
  }
  /* The watch protocol has already published the exact identity seal before
   * reaching this enrichment step. Keep the event loop responsive and retry
   * metadata on later reconciliations instead of blocking all fork tracking
   * for the point-observation retry budget. */
  status = read_bsd_info(pid, bsd);
  if (status != 0) {
    return watch_metadata_status(pid, before.p_uniqueid);
  }
  errno = 0;
  pid_t session_after = getsid(pid);
  if (session_after < 0) {
    int saved_errno = errno;
    if (saved_errno == ESRCH) return 3;
    fprintf(stderr, "observer getsid-after pid=%ld errno=%d\n", (long)pid,
            saved_errno);
    return watch_metadata_status(pid, before.p_uniqueid);
  }
#ifdef DURE_OWNERSHIP_OBSERVER_FAULT_INJECTION
  if (fault_enabled("member-session-drift")) {
    session_after = session_before == 1 ? 2 : 1;
  }
#endif
  status = read_identity(pid, identity);
  if (status != 0) return status;
  if (before.p_uniqueid != identity->p_uniqueid) return 3;
  if (session_before != session_after) {
    fprintf(stderr,
            "observer process session drift pid=%ld before=%ld after=%ld\n",
            (long)pid, (long)session_before, (long)session_after);
    return EXACT_MEMBER_METADATA_UNAVAILABLE;
  }
  *session_id = session_after;
  return 0;
}

static int read_exact_member(pid_t pid,
                             struct dure_proc_uniqidentifierinfo *identity,
                             struct proc_bsdinfo *bsd, pid_t *session_id) {
  int status = read_exact_member_for_watch(pid, identity, bsd, session_id);
  return status == EXACT_MEMBER_METADATA_UNAVAILABLE ? 15 : status;
}

static int emit_exact_member(
    pid_t pid, const struct dure_proc_uniqidentifierinfo *identity,
    const struct proc_bsdinfo *bsd, pid_t session_id,
    const char *boot_session, const char *cwd) {
  if (bsd->pbi_start_tvsec <= 0) return 15;
  if (printf("M %ld %u %u %ld %s kernel-start-v3:macos:%s:%llu %llu",
                (long)pid, bsd->pbi_ppid, bsd->pbi_pgid, (long)session_id,
                member_state(bsd), boot_session,
                (unsigned long long)identity->p_uniqueid,
                (unsigned long long)bsd->pbi_start_tvsec) < 0) return 10;
  if (cwd) {
    if (putchar(' ') == EOF) return 10;
    if (!*cwd && putchar('-') == EOF) return 10;
    for (const unsigned char *byte = (const unsigned char *)cwd; *byte; byte++) {
      if (printf("%02x", *byte) < 0) return 10;
    }
  }
  return putchar('\n') == EOF ? 10 : 0;
}

static int emit_member(pid_t pid, const char *boot_session, int include_cwd) {
  struct dure_proc_uniqidentifierinfo identity;
  struct proc_bsdinfo bsd;
  pid_t session_id;
  int status = read_exact_member(pid, &identity, &bsd, &session_id);
  if (status != 0) return status;
  if (bsd.pbi_pgid <= 1) return 15;
  struct proc_vnodepathinfo paths = {0};
  if (include_cwd && bsd.pbi_status != SZOMB) {
    int size = (int)sizeof(paths);
    errno = 0;
    int observed = fault_enabled("cwd-read-failed") ? 0 :
        proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &paths, size);
    int cwd_errno = errno;
    struct dure_proc_uniqidentifierinfo after;
    status = read_identity(pid, &after);
    if (status != 0) return status;
    if (identity.p_uniqueid != after.p_uniqueid ||
        fault_enabled("cwd-generation-drift")) return 15;
    if (observed != size || paths.pvi_cdir.vip_path[0] != '/' ||
        !memchr(paths.pvi_cdir.vip_path, '\0', MAXPATHLEN)) {
      fprintf(stderr, "process cwd unavailable pid=%ld errno=%d\n",
              (long)pid, cwd_errno);
      return 15;
    }
  }
  status = emit_exact_member(pid, &identity, &bsd, session_id, boot_session,
                             include_cwd ? paths.pvi_cdir.vip_path : NULL);
  if (status != 0) return status;
  return fflush(stdout) == 0 ? 0 : 10;
}

static int observe_points(int count, char **values, int include_cwd) {
  char boot_session[BOOT_SESSION_UUID_SIZE];
  int status = read_boot_session_uuid(boot_session);
  if (status != 0) return status;
  for (int index = 0; index < count; index++) {
    pid_t pid;
    status = parse_pid(values[index], &pid);
    if (status != 0) return status;
    status = emit_member(pid, boot_session, include_cwd);
    if (status != 0 && status != 3) return status;
  }
  return 0;
}

static int observe_group(pid_t group_id) {
  char boot_session[BOOT_SESSION_UUID_SIZE];
  int result = read_boot_session_uuid(boot_session);
  if (result != 0) return result;
  pid_t *candidates = NULL;
  int count = 0;
  result = list_group_pids(group_id, &candidates, &count);
  if (result != 0) return result;
  for (int index = 0; index < count; index++) {
    pid_t pid = candidates[index];
    if (pid <= 1) continue;
    struct dure_proc_uniqidentifierinfo identity;
    struct proc_bsdinfo bsd;
    pid_t session_id;
    int status = read_exact_member(pid, &identity, &bsd, &session_id);
    if (status == 3) continue;
    if (status != 0) {
      result = status;
      break;
    }
    if ((pid_t)bsd.pbi_pgid != group_id) continue;
    status = emit_exact_member(pid, &identity, &bsd, session_id, boot_session, NULL);
    if (status != 0) {
      result = status;
      break;
    }
  }
  free(candidates);
  if (result != 0) return result;
  return fflush(stdout) == 0 ? 0 : 10;
}

static int observe_user_topology(int closed_enumeration) {
  char boot_session[BOOT_SESSION_UUID_SIZE];
  int result = read_boot_session_uuid(boot_session);
  if (result != 0) return result;
  pid_t *candidates = NULL;
  int count = 0;
  result = list_user_pids(&candidates, &count);
  if (result != 0) return result;
  for (int index = 0; index < count; index++) {
    pid_t pid = candidates[index];
    if (pid <= 1 || pid == getpid()) continue;
    struct dure_proc_uniqidentifierinfo identity;
    struct proc_bsdinfo bsd;
    pid_t session_id;
    int status = read_exact_member(pid, &identity, &bsd, &session_id);
    if (status == 3) continue;
    if (status != 0) {
      result = status;
      break;
    }
    uid_t observed_uid = bsd.pbi_uid;
    if (fault_enabled("user-topology-uid-mismatch")) {
      observed_uid = geteuid() == 0 ? 1 : 0;
    }
    if (observed_uid != geteuid()) {
      if (closed_enumeration) {
        result = 15;
        break;
      }
      continue;
    }
    if (bsd.pbi_pgid == 0) continue;
    status = emit_exact_member(pid, &identity, &bsd, session_id, boot_session, NULL);
    if (status != 0) {
      result = status;
      break;
    }
  }
  free(candidates);
  if (result != 0) return result;
  return fflush(stdout) == 0 ? 0 : 10;
}

static int observe_user_identities(void) {
  char boot_session[BOOT_SESSION_UUID_SIZE];
  int result = read_boot_session_uuid(boot_session);
  if (result != 0) return result;
  pid_t *candidates = NULL;
  int count = 0;
  result = list_user_pids(&candidates, &count);
  if (result != 0) return result;
  for (int index = 0; index < count; index++) {
    pid_t pid = candidates[index];
    if (pid <= 1 || pid == getpid()) continue;
    struct dure_proc_uniqidentifierinfo identity;
    int status = read_identity(pid, &identity);
    if (status == 3) continue;
    if (status != 0) {
      result = status;
      break;
    }
    if (printf("I %ld %s %llu %llu\n", (long)pid, boot_session,
               (unsigned long long)identity.p_uniqueid,
               (unsigned long long)identity.p_puniqueid) < 0) {
      result = 10;
      break;
    }
  }
  free(candidates);
  if (result != 0) return result;
  return fflush(stdout) == 0 ? 0 : 10;
}

static int observe_user_census(int count, char **arguments) {
  if (count != 0 && count != 3) return 2;
  if (count == 3) {
    pid_t pid;
    uint64_t uniqueid;
    int status = parse_pid(arguments[0], &pid);
    if (status != 0) return status;
    status = parse_uniqueid(arguments[2], &uniqueid);
    if (status != 0) return status;
    int boot_status = require_boot_session(arguments[1]);
    if (boot_status != 0 && boot_status != 4) return boot_status;
    struct dure_proc_uniqidentifierinfo identity;
    status = read_identity(pid, &identity);
    if (status != 0 && status != 3) return status;
    if (status == 0 && (boot_status == 4 || identity.p_uniqueid != uniqueid)) {
      fprintf(stderr, "process generation changed pid=%ld\n", (long)pid);
      return 4;
    }
    /* ESRCH permits the census to observe remaining descendants. It does not
     * establish group ownership or authorize a signal or root retirement. */
  }
  return observe_user_topology(1);
}

static int exec_gate(char **arguments) {
  char command = '\0';
  ssize_t bytes;
  do {
    bytes = read(STDIN_FILENO, &command, 1);
  } while (bytes < 0 && errno == EINTR);
  if (bytes != 1 || command != 'G') return 16;
  if (dup2(4, STDIN_FILENO) < 0) return 17;
  close(4);
  execvp(arguments[0], arguments);
  fprintf(stderr, "execvp errno=%d\n", errno);
  return 18;
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "exec-gate") == 0) {
    return exec_gate(&argv[2]);
  }
  if (argc >= 3 && strcmp(argv[1], "observe-point") == 0) {
    return observe_points(argc - 2, &argv[2], 0);
  }
  if (argc >= 3 && strcmp(argv[1], "observe-point-cwd") == 0) {
    return observe_points(argc - 2, &argv[2], 1);
  }
  if (argc == 3 && strcmp(argv[1], "observe-group") == 0) {
    pid_t group_id;
    int group_status = parse_pid(argv[2], &group_id);
    return group_status == 0 ? observe_group(group_id) : group_status;
  }
  if (argc == 2 && strcmp(argv[1], "observe-user-topology") == 0) {
    return observe_user_topology(0);
  }
  if (argc >= 2 && strcmp(argv[1], "observe-user-census") == 0) {
    return observe_user_census(argc - 2, &argv[2]);
  }
  if (argc == 2 && strcmp(argv[1], "observe-user-identities") == 0) {
    return observe_user_identities();
  }
  if (argc < 3) return 2;
  pid_t pid;
  int status = parse_pid(argv[2], &pid);
  if (status != 0) return status;

  if (argc == 3 && strcmp(argv[1], "read") == 0) {
    struct dure_proc_uniqidentifierinfo info;
    status = read_identity(pid, &info);
    if (status != 0) return status;
    char boot_session[BOOT_SESSION_UUID_SIZE];
    status = read_boot_session_uuid(boot_session);
    if (status != 0) return status;
    printf("kernel-start-v3:macos:%s:%llu\n", boot_session,
           (unsigned long long)info.p_uniqueid);
    return 0;
  }

  if (argc != 5 && argc != 6) return 2;
  status = require_boot_session(argv[3]);
  if (status != 0) return status;
  uint64_t uniqueid;
  status = parse_uniqueid(argv[4], &uniqueid);
  if (status != 0) return status;
  if (argc == 5 && strcmp(argv[1], "watch") == 0) {
    return watch_identity(pid, uniqueid);
  }
  if (argc == 5 && strcmp(argv[1], "stopped") == 0) {
    return identity_is_stopped(pid, uniqueid);
  }
  if (argc == 6 && strcmp(argv[1], "signal") == 0) {
    char *end = NULL;
    long raw_signal = strtol(argv[5], &end, 10);
    if (!end || *end || raw_signal <= 0) return 2;
    return signal_identity(pid, uniqueid, (int)raw_signal);
  }
  return 2;
}
