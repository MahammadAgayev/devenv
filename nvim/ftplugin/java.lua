-- ftplugin/java.lua — runs for every Java buffer.
-- 1. Sets ulsp SCIP keymaps (always available, regardless of LSP).
-- 2. Starts nvim-jdtls when a JDK and mason jdtls install are present.

-- ulsp SCIP keymaps --------------------------------------------------------
local java_ok, java = pcall(require, "aghayev.java")
if java_ok then
    vim.keymap.set("n", "<leader>js", java.sync_file, { buffer = 0, desc = "Java: sync file (ulsp)" })
    vim.keymap.set("n", "<leader>ji", java.index_target, { buffer = 0, desc = "Java: index target" })
    vim.keymap.set("n", "<leader>ja", java.sync_all, { buffer = 0, desc = "Java: sync all" })
end

-- nvim-jdtls ---------------------------------------------------------------
local jdtls_ok, jdtls = pcall(require, "jdtls")
if not jdtls_ok then return end

local root_dir = vim.fs.root(0, { ".git" })
if not root_dir then return end

-- Only on bazel Java monorepos (fievel / java-code).
if vim.fn.filereadable(root_dir .. "/tools/bazel") == 0 then return end

-- Platform detection -------------------------------------------------------
local uname = vim.uv.os_uname()
local os_arch
if uname.sysname == "Darwin" then
    os_arch = uname.machine == "arm64" and "darwin_arm64" or "darwin_amd64"
else
    os_arch = uname.machine == "aarch64" and "linux_arm64" or "linux_amd64"
end

local os_config_suffix = uname.sysname == "Darwin" and "config_mac" or "config_linux"

-- JDK from bazel cache -----------------------------------------------------
local home = vim.fn.expand("~")
local cache_base = home .. "/.java_bazelcache/workspace"

local function find_bazel_jdk(version)
    local hits = vim.fn.glob(
        cache_base .. "/*/external/+jdk_repositories+monorepo_jdk_" .. version .. "_" .. os_arch,
        false, true)
    return hits[1]
end

-- JDTLS needs JDK 21+ to run; prefer 21 (stable), fall back to 25/17.
local jdk_home = find_bazel_jdk("21") or find_bazel_jdk("25") or find_bazel_jdk("17")
if not jdk_home then return end

local java_bin = jdk_home .. "/bin/java"

-- Lombok agent -------------------------------------------------------------
local function find_lombok()
    local hits = vim.fn.glob(
        cache_base .. "/*/external/+jvm_repositories+org_projectlombok_lombok-*.jar",
        false, true)
    for _, jar in ipairs(hits) do
        if not jar:match("-sources%.jar$") then return jar end
    end
end

local lombok_jar = find_lombok()

-- Mason jdtls --------------------------------------------------------------
local mason_jdtls = vim.fn.stdpath("data") .. "/mason/packages/jdtls"
if vim.fn.isdirectory(mason_jdtls) == 0 then
    vim.notify("jdtls not installed — run :MasonInstall jdtls", vim.log.levels.WARN, { title = "jdtls" })
    return
end

local launcher = vim.fn.glob(mason_jdtls .. "/plugins/org.eclipse.equinox.launcher_*.jar")
if launcher == "" then return end

local os_config = mason_jdtls .. "/" .. os_config_suffix

-- Workspace data (persisted per-project) -----------------------------------
local project_name = vim.fn.fnamemodify(root_dir, ":t")
local workspace_dir = home .. "/.cache/jdtls-workspace/" .. project_name

-- Build command ------------------------------------------------------------
local cmd = {
    java_bin,
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
    "-configuration", os_config,
    "-data", workspace_dir,
})

-- Capabilities (shared with cmp) -------------------------------------------
local cmp_ok, cmp_lsp = pcall(require, "cmp_nvim_lsp")
local capabilities = vim.tbl_deep_extend(
    "force",
    {},
    vim.lsp.protocol.make_client_capabilities(),
    cmp_ok and cmp_lsp.default_capabilities() or {}
)

-- Runtime for the project (source level 25, matching .bazelrc) -------------
local jdk25_home = find_bazel_jdk("25") or jdk_home
local runtimes = {
    { name = "JavaSE-25", path = jdk25_home, default = true },
}
if jdk25_home ~= jdk_home then
    table.insert(runtimes, { name = "JavaSE-21", path = jdk_home })
end

-- Config -------------------------------------------------------------------
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

-- JDTLS-specific keymaps ---------------------------------------------------
vim.keymap.set("n", "<leader>jo", jdtls.organize_imports, { buffer = 0, desc = "Java: organize imports" })
vim.keymap.set("n", "<leader>jv", jdtls.extract_variable, { buffer = 0, desc = "Java: extract variable" })
vim.keymap.set("v", "<leader>jv", function() jdtls.extract_variable(true) end, { buffer = 0, desc = "Java: extract variable" })
vim.keymap.set("n", "<leader>jc", jdtls.extract_constant, { buffer = 0, desc = "Java: extract constant" })
vim.keymap.set("v", "<leader>jc", function() jdtls.extract_constant(true) end, { buffer = 0, desc = "Java: extract constant" })
vim.keymap.set("v", "<leader>jm", function() jdtls.extract_method(true) end, { buffer = 0, desc = "Java: extract method" })
