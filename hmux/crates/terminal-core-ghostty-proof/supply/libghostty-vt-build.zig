const std = @import("std");
const buildpkg = @import("src/build/main.zig");

const app_zon_version = @import("build.zig.zon").version;
const lib_version = "0.1.0-dev";
const minimum_zig_version = @import("build.zig.zon").minimum_zig_version;

comptime {
    buildpkg.requireZig(minimum_zig_version);
}

pub fn build(b: *std.Build) !void {
    const file_version: ?[]const u8 = if (b.build_root.handle.readFileAlloc(
        b.graph.io,
        "VERSION",
        b.allocator,
        .limited(128),
    )) |content| std.mem.trim(
        u8,
        content,
        &std.ascii.whitespace,
    ) else |_| null;

    const config = try buildpkg.Config.init(
        b,
        file_version orelse app_zon_version,
        lib_version,
    );
    if (!config.emit_lib_vt) return error.LibGhosttyVtOnly;

    const uucode_tables = tables: {
        const uucode = b.dependency("uucode", .{
            .build_config_path = b.path("src/build/uucode_config.zig"),
        });
        break :tables uucode.namedLazyPath("tables.zig");
    };
    const uucode_mod = b.dependency("uucode", .{
        .tables_path = uucode_tables,
        .build_config_path = b.path("src/build/uucode_config.zig"),
    }).module("uucode");
    const deps: buildpkg.SharedDeps = .{
        .config = &config,
        .options = undefined,
        .help_strings = undefined,
        .metallib = null,
        .unicode_tables = try buildpkg.UnicodeTables.init(b, uucode_tables),
        .framedata = undefined,
        .uucode_tables = uucode_tables,
        .uucode_mod = uucode_mod,
    };
    const simdutf = b.lazyDependency("simdutf", .{
        .target = config.target,
        .optimize = config.optimize,
        .no_libcxx = true,
    }) orelse return error.MissingSimdutf;
    simdutf.artifact("simdutf").root_module.strip = true;
    const highway = b.lazyDependency("highway", .{
        .target = config.target,
        .optimize = config.optimize,
    }) orelse return error.MissingHighway;
    highway.artifact("highway").root_module.strip = true;

    const modules = try buildpkg.GhosttyZig.init(b, &config, &deps);
    modules.vt.strip = true;
    modules.vt_c.strip = true;
    const library = try buildpkg.GhosttyLibVt.initStatic(b, &modules);
    library.install(b.getInstallStep());
    const static_lib_name = if (config.target.result.os.tag == .windows)
        "ghostty-vt-static.lib"
    else
        "libghostty-vt.a";
    b.getInstallStep().dependOn(&b.addInstallLibFile(
        library.output,
        static_lib_name,
    ).step);
}
