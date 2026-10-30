; Tauri NSIS hooks. Kept ASCII-only so the generated installer does not need a BOM.
;
; The app is a tray app: an upgrade over a running instance must stop the app
; (and its Node sidecar) before replacing llmapi-manager.exe. taskkill /T also
; terminates the child node.exe process tree.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /IM llmapi-manager.exe /T /F'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /IM llmapi-manager.exe /T /F'
!macroend
