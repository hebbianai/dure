import { expect, it } from "vitest";
import {
	remoteDirectoryParent,
	remoteDirectoryPath,
	remoteDirectoryQuery,
} from "./remoteDirectoryBrowser";

it("queries Windows drive paths and stays at the drive root on parent navigation", () => {
	expect(remoteDirectoryQuery("C:\\Users\\dev\\Do", "C:/Users/dev")).toEqual({
		directory: "C:/Users/dev",
		fragment: "Do",
	});
	expect(remoteDirectoryQuery("D:\\", "C:/Users/dev")).toEqual({
		directory: "D:/",
		fragment: "",
	});
	expect(remoteDirectoryPath("/C:/Users/dev")).toBe("C:/Users/dev");
	expect(remoteDirectoryParent("C:/Users")).toBe("C:/");
	expect(remoteDirectoryParent("C:/")).toBe("C:/");
});

it("filters within the current directory and preserves POSIX filename characters", () => {
	expect(remoteDirectoryQuery("Doc", "/home/dev")).toEqual({
		directory: "/home/dev",
		fragment: "Doc",
	});
	expect(remoteDirectoryQuery("/home/a\\b/", "/home/dev")).toEqual({
		directory: "/home/a\\b",
		fragment: "",
	});
	expect(remoteDirectoryQuery("~/work/", "/home/dev")).toEqual({
		directory: "~/work",
		fragment: "",
	});
	expect(remoteDirectoryParent("/")).toBe("/");
});
