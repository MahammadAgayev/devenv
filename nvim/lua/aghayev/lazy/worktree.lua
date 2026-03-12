return {
  dir = "/Users/aghayev/Uber/worktree-manager/nvim",
  name = "worktree-manager",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-telescope/telescope.nvim",
  },
  config = function()
    require("worktree-manager").setup({
      cli_path = "python3 -m worktree_manager",
      keymap_prefix = "<leader>w",
      cache_ttl = 5000,
      notifications = true,
      telescope = {
        theme = "dropdown",
        layout_config = {
          width = 0.8,
          height = 0.6,
        },
      },
    })
  end,
}
