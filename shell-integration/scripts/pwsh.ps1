function prompt {
  $e=[char]27;
  $s=$e+'\';
  $p=($PWD.ProviderPath -replace '\\','/') -replace ' ','%20';
  if ($p -notmatch '^/') {
    $p='/'+$p
  };
  Write-Host -NoNewLine ($e+']7;file://localhost'+$p+$s);
  Write-Host -NoNewLine ($e+']779;F'+$s); 'PS '+$PWD.ProviderPath+'> '
}
clear
