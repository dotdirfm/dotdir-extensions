_frd_cd() {
  builtin cd -- "$1"
  printf '\033[1A\033[2K\r'
}

_frd_prompt_hook() {
  local _u; _u=$(printf '%s' "$PWD" | command sed 's/ /%20/g')
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$_u"
  printf '\033]779;F\033\\'
}
PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_frd_prompt_hook"
clear
