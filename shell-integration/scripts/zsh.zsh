precmd(){ 
  local _u=${PWD:gs/ /%20}; 
  printf '\033]7;file://%s%s\033\\' "${HOST:-localhost}" "$_u";
  printf '\033]779;F\033\\';
};
PROMPT='%m:%1~ %# '
clear
