import ExpoModulesCore
import CoreMotion
import Foundation

/**
 * #1542 (ADR-016 S9) — CMMotionManager raw accelerometer fingerprint for lockless BG underground.
 *
 * V1 BG 지하 천장 70 → 90% (Transit App 90% / SubwayPS 학술 85% baseline).
 *
 * 원리:
 *   - `CMMotionManager.accelerometerUpdates`는 Background Location piggyback으로 BG에서도 수신 가능
 *     (Apple Core Motion 공식: location updates 활성 동안 raw 가속도 계속 흐름)
 *   - 1Hz sampling rate (accelerometerUpdateInterval = 1.0s) — 진동 fingerprint 추출 + 발열 완화.
 *     #2509 (interim 발열 완화): 원래 5Hz(Transit App pattern, 0.2s)였으나, backend
 *     `advanceTripPosition.ts` Motion 게이트가 이 모듈의 `motion` 분류를 load-bearing하게 소비해
 *     (isMinimalAlarmEnabled OFF와 무관하게 항상 동작) 완전 gate-off는 부적절 — 대신 continuous
 *     wakeup 빈도만 5배 낮춘다. 60s window RMS 분류는 표본 수가 줄어도(아래 MIN_SAMPLES_FOR_CLASSIFY)
 *     동일 비율로 계속 동작한다.
 *   - 60s sliding window RMS magnitude로 train automotive / walking / stationary 패턴 분류
 *   - native가 latest snapshot 캐시 → JS layer가 `getLatestSnapshot()`으로 polling 조회
 *
 * BG 호환:
 *   - `startAccelerometerUpdates(to: OperationQueue)`로 OperationQueue 명시 — `.main` 사용 시
 *     BG에서 main RunLoop이 suspend되며 callback drop. `OperationQueue()` 신규 queue로 BG 안전.
 *   - `useAccelerometer` (#823 expo-sensors)와 별 lifecycle — expo-sensors는 BG drop. 본 모듈은
 *     Background Location 활성 동안만 의미 있는 BG accelerometer 수신을 보장 (호출자가 lifecycle 관리).
 *
 * Graceful 정책:
 *   - 미지원 디바이스 / 권한 거절 / start 실패 → 모두 no-op + getLatestSnapshot null 반환
 *   - "모르는 상태"는 vote 미투표로 환경 판정 영향 0 (CLAUDE.md feedback_whileinuse_must_work)
 *
 * 분류 임계 (generic, 학습 데이터 없으니 보수적):
 *   - stationary  : RMS < 0.3 m/s² (정지 — 주머니 안 정적 사용자)
 *   - walking     : 0.3 ≤ RMS < 2.0 m/s² (도보 cadence 0.5~2Hz, peak 2~4 m/s²)
 *   - automotive  : RMS ≥ 2.0 m/s² (train 가속/감속 / 진동, peak 5~10 m/s²)
 *   - unknown     : 샘플 부족 (60s window 50개 미만)
 */
public class AccelerometerFingerprintModule: Module {
    private let motionManager = CMMotionManager()
    /** BG-safe queue. main queue는 BG에서 RunLoop 정지로 callback drop. */
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "com.subwaynow.accelerometer-fingerprint"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    /**
     * 60s sliding window — RMS magnitude 추출용. 1초 1 sample × 60s = 60 capacity (안전 여유).
     * lock으로 다중 스레드 접근(JS thread vs accelerometer queue) 보호.
     */
    private var samples: [SampleRecord] = []
    private let samplesLock = NSLock()
    private var isUpdating: Bool = false

    /** 1Hz sampling — #2509 interim 발열 완화 (구 5Hz/0.2s, 모듈 헤더 참고). */
    private static let SAMPLE_INTERVAL_SEC: TimeInterval = 1.0
    /** 60s window. RMS 추출 + 패턴 분류 sample 모집 기간. */
    private static let WINDOW_DURATION_SEC: TimeInterval = 60.0
    /**
     * 분류 신뢰 최소 sample 수 — 60s × 1Hz = 60 기대, 10 미달 시 unknown.
     * #2509: 5Hz(300 기대/50 임계, 16.7%)와 동일 비율(60 × 16.7% ≈ 10)로 낮춰 최초 분류
     * 도달 시간(~10s)을 샘플레이트 변경 전후로 동등하게 유지한다.
     */
    private static let MIN_SAMPLES_FOR_CLASSIFY: Int = 10

    /** stationary 임계 — RMS m/s² 단위. */
    private static let STATIONARY_RMS_MAX: Double = 0.3
    /** walking 상한 — RMS m/s². 도보 cadence는 일반적으로 0.3~2 m/s² 범위. */
    private static let WALKING_RMS_MAX: Double = 2.0

    public func definition() -> ModuleDefinition {
        Name("AccelerometerFingerprint")

        Function("isAvailable") { () -> Bool in
            return self.motionManager.isAccelerometerAvailable
        }

        Function("start") {
            self.startUpdates()
        }

        Function("stop") {
            self.stopUpdates()
        }

        Function("getLatestSnapshot") { () -> [String: Any]? in
            return self.computeLatestSnapshot()
        }
    }

    private func startUpdates() {
        if self.isUpdating { return }
        guard self.motionManager.isAccelerometerAvailable else { return }
        self.motionManager.accelerometerUpdateInterval = AccelerometerFingerprintModule.SAMPLE_INTERVAL_SEC
        self.motionManager.startAccelerometerUpdates(to: self.queue) { [weak self] data, _ in
            guard let self = self, let data = data else { return }
            self.appendSample(data.acceleration)
        }
        self.isUpdating = true
    }

    private func stopUpdates() {
        if !self.isUpdating { return }
        self.motionManager.stopAccelerometerUpdates()
        self.isUpdating = false
        self.samplesLock.lock()
        self.samples.removeAll(keepingCapacity: false)
        self.samplesLock.unlock()
    }

    /**
     * CMAcceleration 단위는 g — SI(m/s²)로 즉시 변환 후 보관.
     * 중력은 sliding window에서 sample 평균 벡터를 중력 가정해 제거 (`computeLatestSnapshot` 내부).
     */
    private func appendSample(_ acc: CMAcceleration) {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000.0)
        let record = SampleRecord(
            tMs: nowMs,
            x: acc.x * AccelerometerFingerprintModule.GRAVITY_MS2,
            y: acc.y * AccelerometerFingerprintModule.GRAVITY_MS2,
            z: acc.z * AccelerometerFingerprintModule.GRAVITY_MS2
        )
        self.samplesLock.lock()
        self.samples.append(record)
        // 60s window 밖은 trim — 무한 적재 방지.
        let cutoffMs = nowMs - Int64(AccelerometerFingerprintModule.WINDOW_DURATION_SEC * 1000.0)
        while let first = self.samples.first, first.tMs < cutoffMs {
            self.samples.removeFirst()
        }
        self.samplesLock.unlock()
    }

    /**
     * 60s window의 sample을 snapshot으로 압축. JS layer가 polling으로 조회한다.
     *
     * 반환 형태 (JS interface `AccelerometerSnapshot`와 1:1):
     *   - timestamp: epoch ms (snapshot 생성 시각)
     *   - rmsMagnitude: 중력 제거 후 linear acceleration RMS (m/s²)
     *   - patternClass: 'stationary' | 'walking' | 'automotive' | 'unknown'
     *   - sampleCount: window 내 sample 수
     */
    private func computeLatestSnapshot() -> [String: Any]? {
        self.samplesLock.lock()
        let snapshot = self.samples
        self.samplesLock.unlock()

        let count = snapshot.count
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000.0)

        if count < AccelerometerFingerprintModule.MIN_SAMPLES_FOR_CLASSIFY {
            return [
                "timestamp": nowMs,
                "rmsMagnitude": 0.0,
                "patternClass": "unknown",
                "sampleCount": count
            ]
        }

        // 중력 벡터 = window 평균 (60s 동안 디바이스 자세 거의 일정 가정).
        var sumX = 0.0
        var sumY = 0.0
        var sumZ = 0.0
        for r in snapshot {
            sumX += r.x
            sumY += r.y
            sumZ += r.z
        }
        let nDouble = Double(count)
        let gravityX = sumX / nDouble
        let gravityY = sumY / nDouble
        let gravityZ = sumZ / nDouble

        // Linear acceleration magnitude RMS — 중력 제거 후 진동 강도.
        var sumSq = 0.0
        for r in snapshot {
            let lx = r.x - gravityX
            let ly = r.y - gravityY
            let lz = r.z - gravityZ
            sumSq += lx * lx + ly * ly + lz * lz
        }
        let rms = sqrt(sumSq / nDouble)

        let patternClass: String
        if rms < AccelerometerFingerprintModule.STATIONARY_RMS_MAX {
            patternClass = "stationary"
        } else if rms < AccelerometerFingerprintModule.WALKING_RMS_MAX {
            patternClass = "walking"
        } else {
            patternClass = "automotive"
        }

        return [
            "timestamp": nowMs,
            "rmsMagnitude": rms,
            "patternClass": patternClass,
            "sampleCount": count
        ]
    }

    /** 표준 중력가속도 (m/s²) — 1g → SI. */
    private static let GRAVITY_MS2: Double = 9.80665

    /** 단일 sample record. SampleBuffer entry. */
    private struct SampleRecord {
        let tMs: Int64
        let x: Double
        let y: Double
        let z: Double
    }
}
