import { useStore } from "@/store";

/** Project names used to label tasks without changing their durable identity. */
export function useTagProjects() {
	return useStore((state) => state.projects);
}
