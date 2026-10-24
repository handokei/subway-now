package com.subwaynow.motionactivity

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * #728 — Android stub.
 *
 * CMMotionActivity와 정확히 대응되는 무권한 API가 Android에는 없다.
 * Google Activity Recognition API는 com.google.android.gms.location.ActivityRecognition 권한이
 * 필요하고 GMS 의존성도 늘어남. iOS 우선 정책(CLAUDE.md / 메모리)에 따라 일단 stub.
 *
 * 모든 함수는 graceful fallback 값을 반환 — JS wrapper(motionActivity.ts)는 false로 인식.
 * 향후 Activity Recognition API 통합 시 같은 인터페이스로 확장.
 */
class MotionActivityModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("MotionActivity")

        Function("isAvailable") { false }

        AsyncFunction("requestPermission") { false }

        Function("startUpdates") { /* no-op */ }

        Function("stopUpdates") { /* no-op */ }

        Function("getCurrentStationary") { false }
    }
}
