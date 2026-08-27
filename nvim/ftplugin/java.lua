-- ftplugin/java.lua — thin wiring layer.
local java = require("aghayev.java")

-- ulsp SCIP keymaps (always available)
vim.keymap.set("n", "<leader>js", java.sync_file, { buffer = 0, desc = "Java: sync file (ulsp)" })
vim.keymap.set("n", "<leader>ji", java.index_target, { buffer = 0, desc = "Java: index target" })
vim.keymap.set("n", "<leader>ja", java.sync_all, { buffer = 0, desc = "Java: sync all" })

-- nvim-jdtls (on bazel monorepos with mason jdtls installed)
java.setup_jdtls()
