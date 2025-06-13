return {
  "zbirenbaum/copilot.lua",
  cmd = "Copilot",
  event = "InsertEnter",
  config = function()
    require("copilot").setup({
      suggestion = { enabled = false },
      panel = { enabled = false },
      auto_trigger = true,
      copilot_model = "claude-3.7-sonnet",
    })    
  end,
}
