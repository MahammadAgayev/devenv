return {
    "greggh/claude-code.nvim",
    dependencies = {
        "nvim-lua/plenary.nvim",
    },
    config = function()
        require("claude-code").setup({
            -- Command configuration
            command = vim.fn.executable("aifx") == 1 and "aifx agent run claude" or "claude", -- aifx is uber-specific

            -- Window configuration
            window = {
                split_ratio = 1.0,
                position = "tab split",
                enter_insert = true,
                hide_numbers = true,
                hide_signcolumn = true,
                float = {
                    width = "100%",
                    height = "100%",
                    row = 0,
                    col = 0,
                    relative = "editor",
                    border = "none",
                },
            },

            -- File refresh configuration
            file_refresh = {
                enable = true,
                updatetime = 300,
                show_notifications = true,
            },

            -- Git integration
            git = {
                use_git_root = false,  -- Use Neovim's cwd instead of git root
            },
        })

        -- Key mappings
        vim.keymap.set("n", "<leader>cc", ":ClaudeCode<CR>", { desc = "Toggle Claude Code (float)" })
        vim.keymap.set("t", "<leader>cc", "<C-\\><C-n>:ClaudeCode<CR>", { desc = "Toggle Claude Code (float)" })
        vim.keymap.set("n", "<leader>cC", ":ClaudeCodeContinue<CR>", { desc = "Continue Claude Code conversation" })
        vim.keymap.set("n", "<leader>cV", ":ClaudeCodeResume<CR>", { desc = "Resume Claude Code conversation" })
    end
}
