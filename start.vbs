' Tradutor — hidden launcher for Windows.
' Double-click to start the server silently in the background,
' or register it to run at login with:  npm run install-startup
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir
' 0 = hidden window, False = don't wait
sh.Run "cmd /c node server.js >> data\server.log 2>&1", 0, False
