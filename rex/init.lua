-- iTerm2 GlobalKeyMap 0xd-0x20000: shift+enter sends a newline (\n)
rex.bind("shift+enter", "pane.send_key", { key = "ctrl+j" })

rex.action{
  name  = "sessionizer",
  title = "Sessionizer",
  run   = function(ctx, args)
    local _, err = rex.session.new_layer{
      bounds = { 0.15, 0.1, 0.7, 0.8 },
      focus  = true,
      layout = rex.layout.block{
        flavor  = "com.superlogical.terminal.shell",
        options = { command = { os.getenv("HOME") .. "/rex-sessionizer" } },
      },
    }
    if err ~= nil then error(err, 0) end
  end,
}

-- Same keys as the tmux prefix, so ctrl+b needs a double press to reach the program.
rex.bind("ctrl+b>f", "sessionizer")
rex.bind("ctrl+b>ctrl+b", "pane.send_key", { key = "ctrl+b" })
