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
-- nvim-jdtls
-- =========================================================================

local function get_output_base(root_dir)
    local result = vim.system(
        { root_dir .. "/tools/bazel", "info", "output_base" },
        { cwd = root_dir, text = true }
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

local function read_source_level(root_dir)
    local rc = root_dir .. "/.bazelrc"
    if vim.fn.filereadable(rc) == 0 then return nil end
    for _, line in ipairs(vim.fn.readfile(rc)) do
        local ver = line:match("^common%s+%-%-java_language_version=(%d+)")
        if ver then return ver end
    end
end

function M.setup_jdtls()
    local jdtls_ok, jdtls = pcall(require, "jdtls")
    if not jdtls_ok then return end

    local root_dir = vim.fs.root(0, { ".git" })
    if not root_dir then return end
    if vim.fn.filereadable(root_dir .. "/tools/bazel") == 0 then return end

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
    local output_base = get_output_base(root_dir)
    if not output_base then return end

    -- JDKs
    local jdtls_jdk = find_jdk(output_base, "21") or find_jdk(output_base, "25") or find_jdk(output_base, "17")
    if not jdtls_jdk then return end

    local source_level = read_source_level(root_dir) or "21"
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

    -- JDTLS keymaps
    vim.keymap.set("n", "<leader>jo", jdtls.organize_imports, { buffer = 0, desc = "Java: organize imports" })
    vim.keymap.set("n", "<leader>jv", jdtls.extract_variable, { buffer = 0, desc = "Java: extract variable" })
    vim.keymap.set("v", "<leader>jv", function() jdtls.extract_variable(true) end, { buffer = 0, desc = "Java: extract variable" })
    vim.keymap.set("n", "<leader>jc", jdtls.extract_constant, { buffer = 0, desc = "Java: extract constant" })
    vim.keymap.set("v", "<leader>jc", function() jdtls.extract_constant(true) end, { buffer = 0, desc = "Java: extract constant" })
    vim.keymap.set("v", "<leader>jm", function() jdtls.extract_method(true) end, { buffer = 0, desc = "Java: extract method" })
end

return M
