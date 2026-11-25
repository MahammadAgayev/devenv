-- Rex app settings live in the macOS app, not on the server, so init.lua
-- cannot set them at load. `python3 sync.py sync` runs this action on macOS;
-- run it by hand with: rex do apply_settings
local themes = require("themes")

local settings = {
  ["interface.appearance.tint"] = true,
  ["interface.panes.density"] = "compact",
  ["interface.panes.headers"] = "always_show",
  ["interface.active_panes.fade"] = "both",
  ["interface.animation.style"] = "snappy",
}

-- "palette:mode" from ~/.devenv.json, set with: python3 sync.py config --rex-theme
local function devenv_theme()
  local f = io.open(os.getenv("HOME") .. "/.devenv.json")
  if f == nil then return "peach-veranda:light" end
  local config = rex.json.decode(f:read("*a"))
  f:close()
  return config.rex_theme or "peach-veranda:light"
end

rex.action{
  name     = "apply_settings",
  title    = "Apply devenv Settings",
  category = "Themes",
  run      = function(ctx, args)
    for key, value in pairs(settings) do
      rex.client.queue("client.setting." .. key, { value = value })
    end
    themes.apply(devenv_theme())
  end,
}
