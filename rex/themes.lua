-- One palette feeds three tools: Rex (terminal colors), Claude Code
-- (~/.claude/themes/rex.json, selected as "custom:rex") and opencode, which
-- uses its "system" theme to read the Rex colors directly.
--
-- A variant with rex_id uses a built-in Rex theme. Other variants are written
-- as Ghostty theme files and imported; Rex reuses the theme ID on re-import.

local palettes = {
  { id = "rose-pine", name = "Rosé Pine",
    dark = {
      name = "Rose Pine Moon",
      background = "#232136", foreground = "#e0def4", cursor = "#e0def4", selection = "#44415a",
      accent = "#ea9a97", muted = "#908caa", subtle = "#6e6a86", added = "#9ccfd8",
      ansi = { "#393552", "#eb6f92", "#3e8fb0", "#f6c177", "#9ccfd8", "#c4a7e7", "#ea9a97", "#e0def4",
               "#6e6a86", "#eb6f92", "#3e8fb0", "#f6c177", "#9ccfd8", "#c4a7e7", "#ea9a97", "#e0def4" },
    },
    light = {
      name = "Rose Pine Dawn",
      background = "#faf4ed", foreground = "#575279", cursor = "#575279", selection = "#dfdad9",
      accent = "#d7827e", muted = "#797593", subtle = "#9893a5", added = "#56949f",
      ansi = { "#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
               "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279" },
    },
  },
  { id = "tokyo-night", name = "Tokyo Night",
    dark = {
      name = "Tokyo Night",
      background = "#1a1b26", foreground = "#c0caf5", cursor = "#c0caf5", selection = "#283457",
      accent = "#ff9e64", muted = "#737aa2", subtle = "#565f89",
      ansi = { "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
               "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5" },
    },
    light = {
      name = "Tokyo Night Day",
      background = "#e1e2e7", foreground = "#3760bf", cursor = "#3760bf", selection = "#b6bfe2",
      accent = "#b15c00", muted = "#68709a", subtle = "#848cb5",
      ansi = { "#e9e9ed", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#6172b0",
               "#a1a6c5", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#3760bf" },
    },
  },
  { id = "peach-veranda", name = "Peach Veranda + Merino Dark",
    dark = {
      rex_id = "merino-dark", name = "Merino Dark",
      background = "#0d1117", foreground = "#e6edf3",
      accent = "#ffa657", muted = "#8b949e", subtle = "#6e7681",
      ansi = { "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
               "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff" },
    },
    light = {
      rex_id = "peach-veranda", name = "Peach Veranda",
      background = "#fdf3ec", foreground = "#4d3a33",
      accent = "#e07a4f", muted = "#8a746a", subtle = "#b8a69c",
      ansi = { "#4d3a33", "#c44f36", "#578c42", "#ab7c1c", "#4472ac", "#9c5589", "#3a8878", "#f0ddd0",
               "#8a746a", "#dc6146", "#67a350", "#c39228", "#5687c2", "#b26a9f", "#48a08e", "#fffaf6" },
    },
  },
}

local function mix(a, b, t)
  local out = "#"
  for i = 2, 6, 2 do
    local x, y = tonumber(a:sub(i, i + 1), 16), tonumber(b:sub(i, i + 1), 16)
    out = out .. string.format("%02x", math.floor(x + (y - x) * t + 0.5))
  end
  return out
end

local function ghostty(v)
  local lines = {
    "background = " .. v.background,
    "foreground = " .. v.foreground,
    "cursor-color = " .. v.cursor,
    "cursor-text = " .. v.background,
    "selection-background = " .. v.selection,
    "selection-foreground = " .. v.foreground,
  }
  for i, c in ipairs(v.ansi) do
    lines[#lines + 1] = string.format("palette = %d=%s", i - 1, c)
  end
  return table.concat(lines, "\n") .. "\n"
end

local function claude(v, mode)
  local a = v.ansi
  local red, green, yellow, blue, magenta, cyan = a[2], a[3], a[4], a[5], a[6], a[7]
  local added = v.added or green
  local bg, fg = v.background, v.foreground
  return {
    name = "Rex: " .. v.name,
    base = mode,
    overrides = {
      claude = v.accent, claudeShimmer = mix(v.accent, fg, 0.3),
      clawd_body = v.accent, briefLabelClaude = v.accent,
      text = fg, inverseText = bg,
      inactive = v.muted, subtle = v.subtle, promptBorder = v.subtle,
      suggestion = blue, permission = blue, remember = blue, ide = blue, briefLabelYou = blue,
      success = added, error = red, warning = yellow, planMode = cyan,
      merged = magenta, autoAccept = magenta, skill = magenta, bashBorder = magenta,
      diffAdded = mix(bg, added, 0.25), diffRemoved = mix(bg, red, 0.25),
      diffAddedDimmed = mix(bg, added, 0.12), diffRemovedDimmed = mix(bg, red, 0.12),
      diffAddedWord = mix(bg, added, 0.45), diffRemovedWord = mix(bg, red, 0.45),
      userMessageBackground = mix(bg, fg, 0.08), userMessageBackgroundHover = mix(bg, fg, 0.12),
      composerSidebarBackground = mix(bg, fg, 0.05),
      bashMessageBackgroundColor = mix(bg, magenta, 0.08), memoryBackgroundColor = mix(bg, blue, 0.08),
      selectionBg = mix(bg, v.accent, 0.3),
    },
  }
end

local function write(path, text)
  local f = assert(io.open(path, "w"))
  f:write(text)
  f:close()
end

local home = os.getenv("HOME")
local rex_dir = home .. "/.config/rex/palettes"
local claude_dir = home .. "/.claude/themes"

local function apply(choice)
  local id, mode = choice:match("^(.-):(%a+)$")
  local palette
  for _, p in ipairs(palettes) do
    if p.id == id then palette = p end
  end
  if palette == nil or palette[mode] == nil then error("unknown theme: " .. choice, 0) end

  rex.exec({ "mkdir", "-p", rex_dir, claude_dir })
  for _, m in ipairs({ "dark", "light" }) do
    local v = palette[m]
    if v.rex_id then
      rex.client.queue("client.setting.themes." .. m .. ".palette", { value = v.rex_id })
    else
      local path = rex_dir .. "/" .. v.name
      write(path, ghostty(v))
      rex.client.queue("client.theme.import", { path = path })
    end
  end
  rex.client.queue("client.setting.interface.appearance.scheme", { value = mode })
  write(claude_dir .. "/rex.json", rex.json.encode(claude(palette[mode], mode), { indent = true }))
end

rex.action{
  name     = "theme",
  title    = "Theme: Rex + Claude Code…",
  category = "Themes",
  args     = { palette = "string?", mode = "string?" },
  run      = function(ctx, args)
    local choice = args.palette and (args.palette .. ":" .. (args.mode or "dark"))
    if choice == nil then
      local items = {}
      for _, p in ipairs(palettes) do
        for _, mode in ipairs({ "dark", "light" }) do
          items[#items + 1] = { id = p.id .. ":" .. mode, title = p.name, subtitle = p[mode].name, detail = mode }
        end
      end
      choice = rex.ui.pick{ title = "Theme", items = items }
      if choice == nil then return end
    end
    apply(choice)
  end,
}

return { apply = apply }
