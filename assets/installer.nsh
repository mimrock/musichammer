; Custom NSIS hooks for electron-builder.
; customUnInstall runs at the end of the uninstall section.
; Guarded with isUpdated so an auto-update reinstall never prompts or deletes.
; /SD IDNO makes silent uninstalls (/S) keep the data without hanging.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "Also delete MusicHammer's data folder?$\r$\n$\r$\nThis removes the downloaded Python runtime and AI models - AND YOUR LIBRARY: every song you imported and every separated stem will be permanently deleted.$\r$\n$\r$\n$LOCALAPPDATA\MusicHammer$\r$\n$\r$\nChoose No to keep your data. A future reinstall will find it again and skip the first-run setup." \
      /SD IDNO IDNO mhKeepData
    RMDir /r "$LOCALAPPDATA\MusicHammer"
    RMDir /r "$APPDATA\MusicHammer"
  mhKeepData:
  ${endIf}
!macroend
