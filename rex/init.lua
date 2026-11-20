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
        -- $HOME must expand on the pane's host, which may be a remote machine.
        options = { command = { "sh", "-c", 'exec "$HOME/rex-sessionizer"' } },
      },
    }
    if err ~= nil then error(err, 0) end
  end,
}

-- tmux-style prefix. ctrl+b needs a double press to reach the program.
local p = "ctrl+b>"
rex.bind(p .. "ctrl+b", "pane.send_key", { key = "ctrl+b" })
rex.bind(p .. "f", "sessionizer")

-- windows (Rex tabs)
rex.bind(p .. "c", "client.tab.new")
rex.bind(p .. "n", "client.tab.next")
rex.bind(p .. "p", "client.tab.previous")
rex.bind(p .. "l", "client.tab.recent.in_session")
rex.bind(p .. ",", "client.tab.rename")
rex.bind(p .. "shift+7", "client.tab.close")            -- &
rex.bind(p .. "shift+,", "client.tab.move.backward")    -- <
rex.bind(p .. "shift+.", "client.tab.move.forward")     -- >
for i = 1, 9 do
  rex.bind(p .. i, "client.tab.goto", { index = i })
end

-- sessions
rex.bind(p .. "s", "session.switch")
rex.bind(p .. "w", "session.switch")
rex.bind(p .. "shift+9", "session.previous")            -- (
rex.bind(p .. "shift+0", "session.next")                -- )
rex.bind(p .. "shift+l", "session.recent")              -- L
rex.bind(p .. "shift+4", "session.rename")              -- $

-- panes
rex.bind(p .. "shift+5", "pane.split.right")            -- %
rex.bind(p .. "shift+'", "pane.split.down")             -- "
rex.bind(p .. "left", "pane.focus.left")
rex.bind(p .. "right", "pane.focus.right")
rex.bind(p .. "up", "pane.focus.up")
rex.bind(p .. "down", "pane.focus.down")
rex.bind(p .. "o", "pane.focus_next")
rex.bind(p .. ";", "pane.focus_recent.in_tab")
rex.bind(p .. "shift+[", "pane.move.left")              -- {
rex.bind(p .. "shift+]", "pane.move.right")             -- }
rex.bind(p .. "z", "pane.zoom")
rex.bind(p .. "x", "pane.close")
rex.bind(p .. "shift+1", "pane.move_to_new_tab")        -- !
rex.bind(p .. "[", "pane.copy_mode.enter")

-- ctrl+b r, then arrows resize until enter or escape
rex.bind(p .. "r", "client.mode.enter", { name = "resize" })
rex.bind("resize/left", "pane.resize", { direction = "left" })
rex.bind("resize/right", "pane.resize", { direction = "right" })
rex.bind("resize/up", "pane.resize", { direction = "up" })
rex.bind("resize/down", "pane.resize", { direction = "down" })
rex.bind("resize/=", "pane.balance")
rex.bind("resize/enter", "client.mode.exit")
rex.bind("resize/escape", "client.mode.exit")
