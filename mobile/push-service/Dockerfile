FROM node:24.15.0-bookworm-slim
WORKDIR /app
# The sender uses the same canonical messages as the phone. No dependency
# installation, application credentials, or terminal state enters the image.
COPY mobile/push-service/apns.mjs mobile/push-service/bindings.mjs mobile/push-service/challenges.mjs mobile/push-service/entrypoint.sh mobile/push-service/grant.mjs mobile/push-service/limits.mjs mobile/push-service/main.mjs mobile/push-service/service.mjs mobile/push-service/
COPY mobile/src/locales/en.ts mobile/src/locales/ko.ts mobile/src/locales/
# COPY keeps the deploying checkout's modes, which a private umask makes
# owner-only. The service reads these files as `node`; none is a secret.
RUN chmod -R a+rX,go-w /app/mobile
# The entrypoint starts as root only to hand the state volume and the APNs
# key file to `node`, then runs the service as `node`.
ENV PORT=8080
EXPOSE 8080
CMD ["/bin/sh", "mobile/push-service/entrypoint.sh"]
