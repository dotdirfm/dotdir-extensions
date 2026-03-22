_faraday_osc779(){ 
  printf '\033]779;F\033\\'
} 
_faraday_osc7_cwd(){ 
  local _u
  _u=$(printf '%s' "$PWD"|command sed -e 's/ /%20/g')
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$_u"
}
_faraday_prompt_hook(){ 
  _faraday_osc7_cwd
  _faraday_osc779
}
PROMPT_COMMAND="_faraday_prompt_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1='\w\$ '
