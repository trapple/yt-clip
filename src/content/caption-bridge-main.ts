import { installBridge } from "@/content/caption-bridge";

// MAIN world の入口 (manifest の world: "MAIN")。頼まれたときだけ字幕の一覧と取得用の URL を返す (ADR 0002)
installBridge();
