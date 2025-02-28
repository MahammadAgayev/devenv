return {
  "zbirenbaum/copilot.lua",
  cmd = "Copilot",
  event = "InsertEnter",
  config = function()
    require("copilot").setup({
            suggestion = { enabled = false },
             panel = {
                enabled = false,
                auto_refresh = false,
                keymap = {
                  jump_prev = "<C-u>",
                  jump_next = "<C-d>",
                  accept = "<C-y>",
                  refresh = "gr",
                  open = "<M-CR>"
               },
               layout = {
                 position = "right", -- | top | left | right | horizontal | vertical
                 ratio = 0.4
               },
            }
        })
  end,
}
