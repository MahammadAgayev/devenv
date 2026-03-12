return {
    "sindrets/diffview.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
        require("diffview").setup({
            enhanced_diff_hl = true,
            view = {
                merge_tool = {
                    layout = "diff3_mixed",
                },
            },
        })

        -- Open diffview to review changes (git review)
        vim.keymap.set("n", "<leader>gr", "<cmd>DiffviewOpen<CR>", { desc = "Git review (diffview)" })

        -- View file history
        vim.keymap.set("n", "<leader>gh", "<cmd>DiffviewFileHistory %<CR>", { desc = "Git file history" })

        -- View all file history
        vim.keymap.set("n", "<leader>gH", "<cmd>DiffviewFileHistory<CR>", { desc = "Git all history" })

        -- Close diffview
        vim.keymap.set("n", "<leader>gc", "<cmd>DiffviewClose<CR>", { desc = "Close diffview" })

        -- Toggle diffview files panel
        vim.keymap.set("n", "<leader>gf", "<cmd>DiffviewToggleFiles<CR>", { desc = "Toggle diffview files" })
    end
}
