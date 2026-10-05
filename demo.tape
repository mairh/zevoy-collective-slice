# Records the capture with charmbracelet/vhs: vhs demo.tape (verified: ~84 s, ends on the summary).
# 62 output lines at 1.1 s each plus ~9 s of ingest and rendering lands near 90 s.
Output demo.mp4
Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1600
Set Height 1000
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "clear" Enter
Show

Type "pnpm -s demo --pace 1100"
Sleep 600ms
Enter
Sleep 88s
