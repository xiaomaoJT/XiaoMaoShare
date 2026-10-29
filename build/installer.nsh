; 安装 / 覆盖升级前先把残留的应用进程结束掉。
; 否则旧进程还占着安装目录里的文件，NSIS 写入时报
; 「不能打开要写入的文件」，点「忽略」会得到一个卸载完没装上的残局。
!macro customInit
  ; 注意：这里不能用 ${APP_EXECUTABLE_FILENAME} —— 它在 common.nsh 里才 !define，
  ; 晚于 customInit 的展开点，会报 unknown variable/constant（警告被视为错误）。
  ; PRODUCT_FILENAME 是构建时由命令行传入的编译器常量，任何位置都可用。
  nsExec::Exec 'taskkill /F /T /IM "${PRODUCT_FILENAME}.exe"'
  Pop $0
  ; 给杀软扫描和文件句柄释放留一点时间，避免瞬时锁
  Sleep 800
!macroend
