# Powerlevel10k config — mirrors pi's statusline (pi/extensions/statusline).
#
# pi renders two rows: a transparent status bar (no filled backgrounds, segments
# joined by a dim " · ", colors straight from the active theme) and a prompt row
# whose gutter is a thick accent bar "▌ ".
#
# Layout here, matching that structure:
#
#    ~/devenv ·  main                              ✘1 · 2.3s · ⚙ ·  14:22
#   ▌ █
#
# Segments with no shell equivalent (model, thinking level, cost, the context
# gauge) are replaced by shell-native ones on the right; the gauge's slot is
# left as empty gap, exactly where pi draws the meter.
#
# Colors are the rose-pine-moon theme (pi/themes/rose-pine-moon.json), hardcoded
# as hex so p10k renders the same tones as pi:
#
#   accent/foam  #9ccfd8   warning/gold  #f6c177   error/love   #eb6f92
#   muted/subtle #908caa   dim           #6e6a86   success      #95b1ac
#   thinkingHigh #c4a7e7   borderMuted   #56526e
#
# Type `p10k configure` to regenerate a stock config (it overwrites this file).

# Temporarily change options.
'builtin' 'local' '-a' 'p10k_config_opts'
[[ ! -o 'aliases'         ]] || p10k_config_opts+=('aliases')
[[ ! -o 'sh_glob'         ]] || p10k_config_opts+=('sh_glob')
[[ ! -o 'no_brace_expand' ]] || p10k_config_opts+=('no_brace_expand')
'builtin' 'setopt' 'no_aliases' 'no_sh_glob' 'brace_expand'

() {
  emulate -L zsh -o extended_glob

  # Unset all configuration options. This allows you to apply configuration changes without
  # restarting zsh. Edit ~/.p10k.zsh and type `source ~/.p10k.zsh`.
  unset -m '(POWERLEVEL9K_*|DEFAULT_USER)~POWERLEVEL9K_GITSTATUS_DIR'

  # Zsh >= 5.1 is required.
  [[ $ZSH_VERSION == (5.<1->*|<6->.*) ]] || return

  ##############################  theme palette  ##############################
  # pi's theme colors, referenced by name below.
  local accent='#9ccfd8'      # foam
  local muted='#908caa'       # subtle
  local dim='#6e6a86'         # muted
  local warning='#f6c177'     # gold
  local error='#eb6f92'       # love
  local success='#95b1ac'
  local iris='#c4a7e7'        # thinkingHigh

  # Raw SGR for the dim separator. p10k runs separator icons through
  # `_p9k_escape`, which quotes `%F{#6e6a86}` into a literal instead of a color
  # directive, so the escape sequence has to be written out directly.
  local dim_sgr=$'\e[38;2;110;106;134m'

  ##############################  bar structure  ##############################
  # Row 1: left group, gap (pi's gauge slot), right group.  Row 2: prompt.
  typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(
    dir                     # ' ~/devenv
    vcs                     # ' main
    newline
    prompt_char             # ▌
  )

  typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(
    status                  # exit code of the last command
    command_execution_time  # duration of the last command
    background_jobs         # presence of background jobs
    time                    # wall clock
  )

  typeset -g POWERLEVEL9K_MODE=nerdfont-v3
  typeset -g POWERLEVEL9K_ICON_PADDING=none

  # Transparent mode: pi paints each segment in its own color on the terminal
  # background rather than filling a background, so no segment has one here.
  typeset -g POWERLEVEL9K_BACKGROUND=

  # pi joins segments with a dim " · ". The surrounding spaces live in the
  # separator itself because LEFT/RIGHT_WHITESPACE are zeroed below to keep the
  # groups flush with the terminal edges.
  typeset -g POWERLEVEL9K_LEFT_SEGMENT_SEPARATOR="${dim_sgr} · "
  typeset -g POWERLEVEL9K_RIGHT_SEGMENT_SEPARATOR="${dim_sgr} · "
  typeset -g POWERLEVEL9K_LEFT_SUBSEGMENT_SEPARATOR="${dim_sgr} · "
  typeset -g POWERLEVEL9K_RIGHT_SUBSEGMENT_SEPARATOR="${dim_sgr} · "
  # No end caps: pi's bar has no chrome bracketing the groups.
  typeset -g POWERLEVEL9K_LEFT_PROMPT_LAST_SEGMENT_END_SYMBOL=
  typeset -g POWERLEVEL9K_RIGHT_PROMPT_FIRST_SEGMENT_START_SYMBOL=
  typeset -g POWERLEVEL9K_LEFT_PROMPT_FIRST_SEGMENT_START_SYMBOL=
  typeset -g POWERLEVEL9K_RIGHT_PROMPT_LAST_SEGMENT_END_SYMBOL=
  # Flush left, flush right — the bar spans the full width like pi's.
  typeset -g POWERLEVEL9K_LEFT_{LEFT,RIGHT}_WHITESPACE=
  typeset -g POWERLEVEL9K_RIGHT_{LEFT,RIGHT}_WHITESPACE=
  typeset -g POWERLEVEL9K_{LEFT,RIGHT}_MIDDLE_WHITESPACE=' '
  # pi always writes the icon before the text, on both sides of the bar; p10k
  # puts it after the content on right-aligned segments unless told otherwise.
  typeset -g POWERLEVEL9K_ICON_BEFORE_CONTENT=true

  # No connector lines between the rows: pi's bar is detached, drawn directly
  # above the prompt with nothing linking them.
  typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_PREFIX=
  typeset -g POWERLEVEL9K_MULTILINE_NEWLINE_PROMPT_PREFIX=
  typeset -g POWERLEVEL9K_MULTILINE_LAST_PROMPT_PREFIX=
  typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_SUFFIX=
  typeset -g POWERLEVEL9K_MULTILINE_NEWLINE_PROMPT_SUFFIX=
  typeset -g POWERLEVEL9K_MULTILINE_LAST_PROMPT_SUFFIX=
  typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_GAP_CHAR=' '
  typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_GAP_BACKGROUND=
  typeset -g POWERLEVEL9K_MULTILINE_NEWLINE_PROMPT_GAP_BACKGROUND=

  # Blank line above the bar, mirroring the breathing room pi leaves around its
  # composer block.
  typeset -g POWERLEVEL9K_PROMPT_ADD_NEWLINE=true

  ##############################  prompt gutter  ##############################
  # pi's `borderless` shape: a thick block bar in the accent color, U+258C.
  typeset -g POWERLEVEL9K_PROMPT_CHAR_BACKGROUND=
  typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_{VIINS,VICMD,VIVIS,VIOWR}_FOREGROUND=$accent
  # pi has no failed-prompt state; use its `error` color so a bad exit still
  # reads at a glance without leaving the palette.
  typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_{VIINS,VICMD,VIVIS,VIOWR}_FOREGROUND=$error
  typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_VIINS_CONTENT_EXPANSION='▌'
  typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_VICMD_CONTENT_EXPANSION='▐'
  typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_VIVIS_CONTENT_EXPANSION='V'
  typeset -g POWERLEVEL9K_PROMPT_CHAR_{OK,ERROR}_VIOWR_CONTENT_EXPANSION='▶'
  typeset -g POWERLEVEL9K_PROMPT_CHAR_OVERWRITE_STATE=true
  typeset -g POWERLEVEL9K_PROMPT_CHAR_LEFT_PROMPT_LAST_SEGMENT_END_SYMBOL=
  typeset -g POWERLEVEL9K_PROMPT_CHAR_LEFT_PROMPT_FIRST_SEGMENT_START_SYMBOL=
  typeset -g POWERLEVEL9K_PROMPT_CHAR_LEFT_LEFT_WHITESPACE=
  # The single space between "▌" and the typed command, as in pi's composer.
  typeset -g POWERLEVEL9K_PROMPT_CHAR_LEFT_RIGHT_WHITESPACE=' '

  ##################################  dir  ####################################
  # pi's `path` segment: whole path in one muted tone, folder glyph, `~` for
  # $HOME, shortened from the left once it passes 40 characters.
  typeset -g POWERLEVEL9K_DIR_FOREGROUND=$muted
  typeset -g POWERLEVEL9K_DIR_SHORTENED_FOREGROUND=$muted
  typeset -g POWERLEVEL9K_DIR_ANCHOR_FOREGROUND=$muted
  typeset -g POWERLEVEL9K_DIR_ANCHOR_BOLD=false
  typeset -g POWERLEVEL9K_SHORTEN_STRATEGY=truncate_absolute
  typeset -g POWERLEVEL9K_SHORTEN_DELIMITER='…'
  # `truncate_absolute` keeps the trailing SHORTEN_DIR_LENGTH characters, which
  # is exactly what pi's `shortenPath(cwd, 40)` does. DIR_MAX_LENGTH is a
  # separate, width-driven mechanism and does not drive this strategy.
  typeset -g POWERLEVEL9K_SHORTEN_DIR_LENGTH=40
  typeset -g POWERLEVEL9K_DIR_MAX_LENGTH=40
  typeset -g POWERLEVEL9K_DIR_MIN_COMMAND_COLUMNS=40
  typeset -g POWERLEVEL9K_DIR_MIN_COMMAND_COLUMNS_PCT=50
  typeset -g POWERLEVEL9K_DIR_HYPERLINK=false
  # pi shows no lock / not-writable state.
  typeset -g POWERLEVEL9K_DIR_SHOW_WRITABLE=false
  typeset -g POWERLEVEL9K_DIR_VISUAL_IDENTIFIER_EXPANSION=$'\uf115'
  typeset -g POWERLEVEL9K_DIR_VISUAL_IDENTIFIER_COLOR=$muted

  ##################################  vcs  ####################################
  # pi's `git` segment is the branch name and nothing else, in the warning
  # color, behind a branch glyph. No dirty markers, no ahead/behind counts.
  typeset -g POWERLEVEL9K_VCS_BACKENDS=(git)
  typeset -g POWERLEVEL9K_VCS_{CLEAN,MODIFIED,UNTRACKED,CONFLICTED,LOADING}_FOREGROUND=$warning
  typeset -g POWERLEVEL9K_VCS_VISUAL_IDENTIFIER_EXPANSION=$'\uf126'
  typeset -g POWERLEVEL9K_VCS_{CLEAN,MODIFIED,UNTRACKED,CONFLICTED,LOADING}_VISUAL_IDENTIFIER_COLOR=$warning
  typeset -g POWERLEVEL9K_VCS_DISABLED_WORKDIR_PATTERN='~'
  # Only the branch (or a short sha when detached), matching pi exactly.
  function pi_git_formatter() {
    typeset -g pi_git_format=${${VCS_STATUS_LOCAL_BRANCH//\%/%%}:-${VCS_STATUS_COMMIT[1,8]}}
  }
  functions -M pi_git_formatter 2>/dev/null
  typeset -g POWERLEVEL9K_VCS_CONTENT_EXPANSION='${$((pi_git_formatter()))+${pi_git_format}}'
  typeset -g POWERLEVEL9K_VCS_LOADING_CONTENT_EXPANSION='${$((pi_git_formatter()))+${pi_git_format}}'

  #################################  status  ##################################
  # pi's `status` segment carries extension statuses; the shell analog is the
  # last exit code. Silent on success, like pi's (which vanishes when empty).
  typeset -g POWERLEVEL9K_STATUS_OK=false
  typeset -g POWERLEVEL9K_STATUS_ERROR=true
  typeset -g POWERLEVEL9K_STATUS_ERROR_FOREGROUND=$error
  typeset -g POWERLEVEL9K_STATUS_ERROR_VISUAL_IDENTIFIER_EXPANSION='✘'
  typeset -g POWERLEVEL9K_STATUS_ERROR_SIGNAL_FOREGROUND=$error
  typeset -g POWERLEVEL9K_STATUS_ERROR_SIGNAL_VISUAL_IDENTIFIER_EXPANSION='✘'
  typeset -g POWERLEVEL9K_STATUS_VERBOSE_SIGNAME=false
  typeset -g POWERLEVEL9K_STATUS_ERROR_PIPE_FOREGROUND=$error
  typeset -g POWERLEVEL9K_STATUS_ERROR_PIPE_VISUAL_IDENTIFIER_EXPANSION='✘'

  ##########################  command_execution_time  #########################
  # Takes the slot pi uses for `cost`: a plain warning-colored number, no icon.
  typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_THRESHOLD=3
  typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_PRECISION=1
  typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_FOREGROUND=$warning
  typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_VISUAL_IDENTIFIER_EXPANSION=

  ############################  background_jobs  ##############################
  # Icon only, in the color pi gives its most "active" segment.
  typeset -g POWERLEVEL9K_BACKGROUND_JOBS_VERBOSE=false
  typeset -g POWERLEVEL9K_BACKGROUND_JOBS_FOREGROUND=$iris
  typeset -g POWERLEVEL9K_BACKGROUND_JOBS_VISUAL_IDENTIFIER_EXPANSION='⚙'
  typeset -g POWERLEVEL9K_BACKGROUND_JOBS_VISUAL_IDENTIFIER_COLOR=$iris

  ##################################  time  ###################################
  # Same glyph and dim tone as pi's `time` segment.
  typeset -g POWERLEVEL9K_TIME_FORMAT='%D{%H:%M}'
  typeset -g POWERLEVEL9K_TIME_FOREGROUND=$dim
  typeset -g POWERLEVEL9K_TIME_UPDATE_ON_COMMAND=false
  typeset -g POWERLEVEL9K_TIME_VISUAL_IDENTIFIER_EXPANSION=$'\uf017'
  typeset -g POWERLEVEL9K_TIME_VISUAL_IDENTIFIER_COLOR=$dim

  #################################  behavior  ################################
  typeset -g POWERLEVEL9K_TRANSIENT_PROMPT=always
  typeset -g POWERLEVEL9K_INSTANT_PROMPT=verbose
  typeset -g POWERLEVEL9K_DISABLE_HOT_RELOAD=true

  # If p10k is already loaded, reload configuration.
  # This works even with POWERLEVEL9K_DISABLE_HOT_RELOAD=true.
  (( ! $+functions[p10k] )) || p10k reload
}

# Tell `p10k configure` which file it should overwrite.
typeset -g POWERLEVEL9K_CONFIG_FILE=${${(%):-%x}:a}

(( ${#p10k_config_opts} )) && setopt ${p10k_config_opts[@]}
'builtin' 'unset' 'p10k_config_opts'
