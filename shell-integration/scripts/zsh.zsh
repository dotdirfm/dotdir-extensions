_frd_cd() {
  builtin cd -- "$1"
  printf '\033[1A\033[2K\r'
}

_frd_precmd() {
  local _u=${PWD:gs/ /%20}
  printf '\033]7;file://%s%s\033\\' "${HOST:-localhost}" "$_u"
  printf '\033]779;F\033\\'
}
setopt HIST_IGNORE_SPACE
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook precmd _frd_precmd
else
  precmd_functions=($precmd_functions _frd_precmd)
fi
clear
