function fish_prompt
  set -l _h (hostname | string trim)
  set -l _p (string replace -a ' ' '%20' $PWD)
  printf '\033]7;file://%s%s\033\\' $_h $_p
  printf '\033]779;F\033\\'
  echo -n (prompt_pwd) '> '
end
clear
