function _frd_cd
  builtin cd -- $argv[1]
  builtin history delete --prefix "_frd_cd" 2>/dev/null
  printf '\033[1A\033[2K\r'
end

# fire before each command so .dir knows a command is running
function fish_preexec
  printf '\033]779;S\033\\'
end

# fish_postexec is an event (not a special hook): must use --on-event.
# Fires after each command exits — NOT from fish_prompt, which can be called
# during TUI apps (mc, vim, ...) and would incorrectly signal "command finished".
function _frd_postexec --on-event fish_postexec
  printf '\033]779;F\033\\'
end

function fish_prompt
  set -l _h (hostname | string trim)
  set -l _p (string replace -a ' ' '%20' $PWD)
  printf '\033]7;file://%s%s\033\\' $_h $_p
  echo -n (prompt_pwd) '> '
end
clear
