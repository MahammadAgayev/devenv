-- Java support: ulsp SCIP indexing + nvim-jdtls.

local M = {}

local KINDS = "java_library|java_test|java_import|scala_library"

local function root()
    local client = vim.lsp.get_clients({ bufnr = 0, name = "ulsp" })[1]
    return client and client.root_dir or vim.fs.root(0, { ".git" })
end

local function notify(msg, level)
    vim.notify(msg, level or vim.log.levels.INFO, { title = "java" })
end

-- =========================================================================
-- ulsp SCIP index control
-- =========================================================================

function M.sync_file()
    local client = vim.lsp.get_clients({ bufnr = 0, name = "ulsp" })[1]
    if not client then
        notify("no ulsp client attached", vim.log.levels.WARN)
        return
    end
    client:request("workspace/executeCommand", {
        command = "ulsp.quick-actions.javasync",
        arguments = { { document = { uri = vim.uri_from_bufnr(0) } } },
    }, function(err)
        if err then
            notify("sync failed: " .. vim.inspect(err), vim.log.levels.ERROR)
        else
            notify("synced " .. vim.fn.expand("%:t"))
        end
    end, 0)
end

local function resolve_target(dir, file, on_done)
    local rel = vim.fs.relpath(dir, file)
    if not rel then
        notify("file is outside " .. dir, vim.log.levels.ERROR)
        return
    end
    local universe = "//" .. vim.split(rel, "/src")[1] .. "/..."
    local query = ("kind(\"%s\", rdeps(%s, %s, 1))"):format(KINDS, universe, rel)

    notify("resolving target for " .. vim.fs.basename(rel) .. "...")
    vim.system({ "./tools/bazel", "query", query }, { cwd = dir, text = true }, function(res)
        local target = vim.trim((res.stdout or ""):match("^[^\n]*") or "")
        if target == "" then
            vim.schedule(function()
                notify("no bazel target found for " .. rel, vim.log.levels.ERROR)
            end)
            return
        end
        local scope = target:gsub(":.*$", "") .. "/..."
        vim.schedule(function() on_done(scope) end)
    end)
end

local function add_to_bazelproject(dir, target)
    local path = dir .. "/.bazelbsp/.bazelproject"
    if vim.fn.filereadable(path) == 0 then
        path = dir .. "/.ijwb/.bazelproject"
    end
    local lines = vim.fn.filereadable(path) == 1 and vim.fn.readfile(path) or { "targets:" }
    for _, line in ipairs(lines) do
        if vim.trim(line) == target then
            return path, false
        end
    end
    table.insert(lines, "  " .. target)
    vim.fn.mkdir(vim.fs.dirname(path), "p")
    vim.fn.writefile(lines, path)
    return path, true
end

function M.index_target()
    local dir, file = root(), vim.api.nvim_buf_get_name(0)
    if not dir then
        notify("no monorepo root", vim.log.levels.ERROR)
        return
    end

    resolve_target(dir, file, function(target)
        local _, added = add_to_bazelproject(dir, target)
        notify(("indexing %s%s (minutes)"):format(target, added and "" or " [already in .bazelproject]"))

        vim.system({ "./tools/scip/scip_sync.sh", target }, { cwd = dir, text = true }, function(res)
            vim.schedule(function()
                local out = (res.stdout or "") .. (res.stderr or "")
                if res.code ~= 0 then
                    notify("index failed:\n" .. out:sub(-500), vim.log.levels.ERROR)
                    return
                end
                local stats = out:match("'passed_index_cnt': %d+") or "done"
                notify(("indexed %s (%s) - reload buffer"):format(target, stats))
            end)
        end)
    end)
end

function M.sync_all()
    local dir = root()
    if not dir then
        notify("no monorepo root", vim.log.levels.ERROR)
        return
    end
    notify("syncing all .bazelproject targets (minutes)")
    vim.system({ "./tools/scip/scip_sync.sh" }, { cwd = dir, text = true }, function(res)
        vim.schedule(function()
            notify(res.code == 0 and "full sync complete" or "full sync failed",
                res.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR)
        end)
    end)
end

-- =========================================================================
-- Eclipse project generation (for JDTLS build path)
-- =========================================================================

-- Discover src/*/java source roots under a bazel package.
local function find_source_dirs(pkg_dir)
    local dirs = {}
    local hits = vim.fn.glob(pkg_dir .. "/src/*/java", false, true)
    for _, d in ipairs(hits) do
        table.insert(dirs, d:sub(#pkg_dir + 2))
    end
    if #dirs == 0 then
        if vim.fn.isdirectory(pkg_dir .. "/src") == 1 then
            table.insert(dirs, "src")
        end
    end
    return dirs
end

local function write_dot_project(pkg_dir, name)
    local lines = {
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<projectDescription>",
        "  <name>" .. name .. "</name>",
        "  <buildSpec>",
        "    <buildCommand>",
        "      <name>org.eclipse.jdt.core.javabuilder</name>",
        "    </buildCommand>",
        "  </buildSpec>",
        "  <natures>",
        "    <nature>org.eclipse.jdt.core.javanature</nature>",
        "  </natures>",
        "</projectDescription>",
    }
    vim.fn.writefile(lines, pkg_dir .. "/.project")
end

local function write_dot_classpath(pkg_dir, source_dirs, lib_jars, jdk_name)
    local lines = { '<?xml version="1.0" encoding="UTF-8"?>', "<classpath>" }
    for _, src in ipairs(source_dirs) do
        table.insert(lines, '  <classpathentry kind="src" path="' .. src .. '"/>')
    end
    table.insert(lines, '  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/'
        .. "org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/" .. jdk_name .. '"/>')
    for _, jar in ipairs(lib_jars) do
        table.insert(lines, '  <classpathentry kind="lib" path="' .. jar .. '"/>')
    end
    table.insert(lines, '  <classpathentry kind="output" path="bin"/>')
    table.insert(lines, "</classpath>")
    vim.fn.writefile(lines, pkg_dir .. "/.classpath")
end

-- Fetch compile classpath jars from bazel cquery (async).
local function fetch_classpath_async(monorepo, pkg_dir, on_done)
    local rel = vim.fs.relpath(monorepo, pkg_dir)
    if not rel then return end
    local pkg = "//" .. rel

    local query = ('kind("java_library|java_test", %s:all)'):format(pkg)
    vim.system({ "./tools/bazel", "query", query }, { cwd = monorepo, text = true }, function(qres)
        local targets = {}
        for line in (qres.stdout or ""):gmatch("[^\n]+") do
            local t = vim.trim(line)
            if t ~= "" then table.insert(targets, t) end
        end
        if #targets == 0 then
            vim.schedule(function() on_done({}) end)
            return
        end

        local target_union = table.concat(targets, " + ")
        local expr = '"\\n".join([f.path for f in providers(target)'
            .. '["@@rules_java+//java/private:java_info.bzl%JavaInfo"]'
            .. ".transitive_compile_time_jars.to_list()])"
        vim.system(
            { "./tools/bazel", "cquery", target_union, "--output=starlark", "--starlark:expr=" .. expr },
            { cwd = monorepo, text = true },
            function(cres)
                local jars = {}
                local seen = {}
                for line in (cres.stdout or ""):gmatch("[^\n]+") do
                    local jar = vim.trim(line)
                    if jar ~= "" and not seen[jar] then
                        seen[jar] = true
                        if not jar:match("^/") then
                            jar = monorepo .. "/" .. jar
                        end
                        table.insert(jars, jar)
                    end
                end
                vim.schedule(function() on_done(jars) end)
            end
        )
    end)
end

-- =========================================================================
-- nvim-jdtls
-- =========================================================================

local function get_output_base(monorepo)
    local result = vim.system(
        { monorepo .. "/tools/bazel", "info", "output_base" },
        { cwd = monorepo, text = true }
    ):wait()
    if result.code == 0 then return vim.trim(result.stdout) end
end

local function find_jdk(output_base, version)
    local uname = vim.uv.os_uname()
    local arch
    if uname.sysname == "Darwin" then
        arch = uname.machine == "arm64" and "darwin_arm64" or "darwin_amd64"
    else
        arch = uname.machine == "aarch64" and "linux_arm64" or "linux_amd64"
    end
    local path = output_base .. "/external/+jdk_repositories+monorepo_jdk_" .. version .. "_" .. arch
    if vim.fn.isdirectory(path) == 1 then return path end
end

local function find_lombok(mason_jdtls, output_base)
    local mason_lombok = mason_jdtls .. "/lombok.jar"
    if vim.fn.filereadable(mason_lombok) == 1 then return mason_lombok end

    local hits = vim.fn.glob(output_base .. "/external/+jvm_repositories+org_projectlombok_lombok-*.jar", false, true)
    for _, p in ipairs(hits) do
        if not p:match("-sources%.jar$") then
            local downloaded = p .. "/file/downloaded"
            if vim.fn.filereadable(downloaded) == 1 then return downloaded end
        end
    end
end

local function read_source_level(monorepo)
    local rc = monorepo .. "/.bazelrc"
    if vim.fn.filereadable(rc) == 0 then return nil end
    for _, line in ipairs(vim.fn.readfile(rc)) do
        local ver = line:match("^common%s+%-%-java_language_version=(%d+)")
        if ver then return ver end
    end
end

function M.setup_jdtls()
    local jdtls_ok, jdtls = pcall(require, "jdtls")
    if not jdtls_ok then return end

    local monorepo = vim.fs.root(0, { ".git" })
    if not monorepo then return end
    if vim.fn.filereadable(monorepo .. "/tools/bazel") == 0 then return end

    local root_dir = vim.fs.root(0, { "BUILD.bazel", "BUILD" }) or monorepo

    -- Mason jdtls
    local mason_jdtls = vim.fn.stdpath("data") .. "/mason/packages/jdtls"
    if vim.fn.isdirectory(mason_jdtls) == 0 then
        notify("jdtls not installed — run :MasonInstall jdtls", vim.log.levels.WARN)
        return
    end

    local launcher = vim.fn.glob(mason_jdtls .. "/plugins/org.eclipse.equinox.launcher_*.jar")
    if launcher == "" then return end

    -- Platform config dir
    local uname = vim.uv.os_uname()
    local os_config_suffix
    if uname.sysname == "Darwin" then
        os_config_suffix = uname.machine == "arm64" and "config_mac_arm" or "config_mac"
    else
        os_config_suffix = uname.machine == "aarch64" and "config_linux_arm" or "config_linux"
    end

    -- Bazel output_base
    local output_base = get_output_base(monorepo)
    if not output_base then return end

    -- JDKs
    local jdtls_jdk = find_jdk(output_base, "21") or find_jdk(output_base, "25") or find_jdk(output_base, "17")
    if not jdtls_jdk then return end

    local source_level = read_source_level(monorepo) or "21"
    local project_jdk = find_jdk(output_base, source_level) or jdtls_jdk

    -- Lombok
    local lombok_jar = find_lombok(mason_jdtls, output_base)

    -- Workspace dir
    local project_name = vim.fn.fnamemodify(root_dir, ":t")
    local workspace_dir = vim.fn.expand("~") .. "/.cache/jdtls-workspace/" .. project_name

    -- Command
    local cmd = {
        jdtls_jdk .. "/bin/java",
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Dlog.protocol=true",
        "-Dlog.level=ALL",
        "-Xmx8G",
        "--add-modules=ALL-SYSTEM",
        "--add-opens", "java.base/java.util=ALL-UNNAMED",
        "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    }
    if lombok_jar then
        table.insert(cmd, "-javaagent:" .. lombok_jar)
    end
    vim.list_extend(cmd, {
        "-jar", launcher,
        "-configuration", mason_jdtls .. "/" .. os_config_suffix,
        "-data", workspace_dir,
    })

    -- Capabilities
    local cmp_ok, cmp_lsp = pcall(require, "cmp_nvim_lsp")
    local capabilities = vim.tbl_deep_extend(
        "force",
        {},
        vim.lsp.protocol.make_client_capabilities(),
        cmp_ok and cmp_lsp.default_capabilities() or {}
    )

    -- Runtimes
    local runtimes = {
        { name = "JavaSE-" .. source_level, path = project_jdk, default = true },
    }
    if project_jdk ~= jdtls_jdk then
        table.insert(runtimes, { name = "JavaSE-21", path = jdtls_jdk })
    end

    -- Generate Eclipse project files so JDTLS knows the source roots
    local jdk_name = "JavaSE-" .. source_level
    local source_dirs = find_source_dirs(root_dir)
    write_dot_project(root_dir, project_name)
    write_dot_classpath(root_dir, source_dirs, {}, jdk_name)

    local config = {
        cmd = cmd,
        root_dir = root_dir,
        capabilities = capabilities,
        settings = {
            java = {
                autobuild = { enabled = false },
                signatureHelp = { enabled = true },
                contentProvider = { preferred = "fernflower" },
                configuration = { runtimes = runtimes },
                completion = {
                    favoriteStaticMembers = {
                        "org.junit.Assert.*",
                        "org.junit.jupiter.api.Assertions.*",
                        "org.mockito.Mockito.*",
                    },
                    importOrder = { "com.uber", "com", "org", "java", "javax" },
                },
                sources = {
                    organizeImports = {
                        starThreshold = 9999,
                        staticStarThreshold = 9999,
                    },
                },
                import = {
                    exclusions = {
                        "**/bazel-*/**",
                        "**/node_modules/**",
                        "**/.git/**",
                    },
                },
                project = {
                    outputPath = workspace_dir .. "/bin",
                },
            },
        },
        init_options = {
            extendedClientCapabilities = jdtls.extendedClientCapabilities,
        },
        handlers = {
            ["language/status"] = function() end,
        },
    }

    jdtls.start_or_attach(config)

    -- Async: fetch classpath from bazel, update .classpath, tell JDTLS to reload
    fetch_classpath_async(monorepo, root_dir, function(jars)
        if #jars == 0 then return end
        write_dot_classpath(root_dir, source_dirs, jars, jdk_name)
        notify(("%d classpath jars resolved"):format(#jars))
        local client = vim.lsp.get_clients({ bufnr = 0, name = "jdtls" })[1]
        if client then
            client:request("java/buildWorkspace", false, function() end, 0)
        end
    end)

    -- JDTLS keymaps
    vim.keymap.set("n", "<leader>jo", jdtls.organize_imports, { buffer = 0, desc = "Java: organize imports" })
    vim.keymap.set("n", "<leader>jv", jdtls.extract_variable, { buffer = 0, desc = "Java: extract variable" })
    vim.keymap.set("v", "<leader>jv", function() jdtls.extract_variable(true) end, { buffer = 0, desc = "Java: extract variable" })
    vim.keymap.set("n", "<leader>jc", jdtls.extract_constant, { buffer = 0, desc = "Java: extract constant" })
    vim.keymap.set("v", "<leader>jc", function() jdtls.extract_constant(true) end, { buffer = 0, desc = "Java: extract constant" })
    vim.keymap.set("v", "<leader>jm", function() jdtls.extract_method(true) end, { buffer = 0, desc = "Java: extract method" })
end

return M
