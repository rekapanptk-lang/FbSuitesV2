' FbSuitesV2 - Silent launcher
' Jalanin browser_scraper.js dengan window minimized
Set WshShell = CreateObject("WScript.Shell")

' Get install dir (folder tempat script ini berada)
Set fso = CreateObject("Scripting.FileSystemObject")
installDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Build command
cmd = "cmd /c cd /d """ & installDir & """ && node browser_scraper.js"

' 1 = normal window (kalo lo mau liat cmd), 7 = minimized, 0 = hidden
' Kita pake 1 dulu biar karyawan bisa liat input prompt "Pilih ID"
' Nanti kalo mau full hidden ganti ke 0
WshShell.Run cmd, 1, False

Set WshShell = Nothing
Set fso = Nothing