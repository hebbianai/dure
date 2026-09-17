const std = @import("std");
const buildpkg = @import("src/build/main.zig");

const app_zon_version = @import("build.zig.zon").version;
const lib_version = "0.1.0-dev";
const minimum_zig_version = @import("build.zig.zon").minimum_zig_version;

comptime {
    buildpkg.requireZig(minimum_zig_version);
}

pub fn build(b: *std.Build) !void {
    const config = try buildpkg.Config.init(
        b,
        app_zon_version,
        lib_version,
    );
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
    const modules = try buildpkg.GhosttyZig.init(b, &config, &deps);
    const shim_module = b.createModule(.{
        .root_source_file = b.path("hmux_history_iterator.zig"),
        .target = config.target,
        .optimize = config.optimize,
        .link_libc = true,
        .pic = true,
    });
    shim_module.addImport("ghostty_vt", modules.vt_c);
    const shim = b.addLibrary(.{
        .name = "hmux-ghostty-history-iterator",
        .linkage = .static,
        .root_module = shim_module,
    });
    b.installArtifact(shim);
}
