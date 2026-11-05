#if os(iOS)
import SwiftUI

// #3221 PR-5 — Line Glass 디자인 토큰 (Night/Light).
//
// ⚠️ SSoT: src/shared/theme/theme.ts (lightColors / darkColors / lineTint).
// 이 파일은 그 값을 Swift로 옮긴 사본이다. theme.ts를 바꾸면 여기도 바꿔야 하고,
// modules/live-activity/__tests__/lineGlassParity.test.ts 가 소스 텍스트로 값 일치를 강제한다
// (토큰 1개라도 어긋나면 jest red). 토큰 선언은 그 테스트가 파싱하는 형식
// `<name>: LGColor(hex: 0xRRGGBB, alpha: A)` 을 유지해야 한다.

/// #RRGGBB + alpha. theme.ts의 '#hex' / 'rgba(r,g,b,a)' 값을 그대로 옮기는 단위.
struct LGColor {
    let hex: UInt32
    let alpha: Double

    var color: Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}

/// LA(잠금화면) 반투명 배경 투명도 — 여정·탑승 LA 공통, 이 1곳에서만 정의한다. (사용자 결정 10/30: 55%)
enum LineGlassLA {
    static let backgroundAlpha = 0.55
}

struct LineGlassPalette {
    let glassFallback: LGColor
    let glassBorder: LGColor
    let glassHighlight: LGColor
    let segmentActive: LGColor
    let inkStrong: LGColor
    let onInkStrong: LGColor
    let ink: LGColor
    let muted: LGColor
    let hair: LGColor
    // LA 전용(theme.ts에 대응 값 없음) — 반투명 배경. lineGlassTranslucent.test.ts가 값을 고정한다.
    let laBackground: LGColor
    let laHighlight: LGColor
    let laBorder: LGColor

    // theme.ts darkColors (Line Glass · Night)
    static let night = LineGlassPalette(
        glassFallback: LGColor(hex: 0x181C1A, alpha: 0.92),
        glassBorder: LGColor(hex: 0xFFFFFF, alpha: 0.10),
        glassHighlight: LGColor(hex: 0xFFFFFF, alpha: 0.14),
        segmentActive: LGColor(hex: 0xFFFFFF, alpha: 0.14),
        inkStrong: LGColor(hex: 0xF2F5F3, alpha: 1),
        onInkStrong: LGColor(hex: 0x07090A, alpha: 1),
        ink: LGColor(hex: 0xF2F5F3, alpha: 1),
        muted: LGColor(hex: 0x8C9A93, alpha: 1),
        hair: LGColor(hex: 0xFFFFFF, alpha: 0.08),
        laBackground: LGColor(hex: 0x181C1A, alpha: LineGlassLA.backgroundAlpha),
        laHighlight: LGColor(hex: 0xFFFFFF, alpha: 0.18),
        laBorder: LGColor(hex: 0xFFFFFF, alpha: 0.12)
    )

    // theme.ts lightColors (Line Glass · Light)
    static let light = LineGlassPalette(
        glassFallback: LGColor(hex: 0xFFFFFF, alpha: 0.86),
        glassBorder: LGColor(hex: 0xFFFFFF, alpha: 0.90),
        glassHighlight: LGColor(hex: 0xFFFFFF, alpha: 1),
        segmentActive: LGColor(hex: 0xFFFFFF, alpha: 1),
        inkStrong: LGColor(hex: 0x0E1512, alpha: 1),
        onInkStrong: LGColor(hex: 0xFFFFFF, alpha: 1),
        ink: LGColor(hex: 0x0E1512, alpha: 1),
        muted: LGColor(hex: 0x55605B, alpha: 1),
        hair: LGColor(hex: 0x0E1512, alpha: 0.07),
        laBackground: LGColor(hex: 0xFFFFFF, alpha: LineGlassLA.backgroundAlpha),
        laHighlight: LGColor(hex: 0xFFFFFF, alpha: 1),
        laBorder: LGColor(hex: 0x0E1512, alpha: 0.08)
    )

    static func resolve(_ scheme: ColorScheme) -> LineGlassPalette {
        scheme == .dark ? night : light
    }
}

/// theme.ts `lineTint(line, isDark)` 수식 상수. (mixHex(base, target, w) / withAlpha(base, a))
enum LineTintSpec {
    static let darkLitMix = 0.3      // lit  = mix(base, #fff, w)
    static let darkTextMix = 0.55    // text = mix(base, #fff, w)
    static let darkGlowAlpha = 0.55  // glow = base @ alpha
    static let lightLitMix = 0.2     // lit  = mix(base, #000, w)
    static let lightTextMix = 0.45   // text = mix(base, #000, w)
    static let lightGlowAlpha = 0.5  // glow = base @ alpha
}

/// 노선색 기반 강조색. lineTint(theme.ts)의 Swift 이식 — base/lit/text/glow.
struct LineTint {
    let base: Color
    let lit: Color
    let text: Color
    let glow: Color

    /// `#RRGGBB`(앞의 `#` 허용). 파싱 실패 시 중립 회색 — 위젯 non-optional 필드가 비어도 그려지게.
    static func rgb(fromHex hex: String) -> (r: Double, g: Double, b: Double) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else {
            return (136, 136, 136)
        }
        return (Double((value >> 16) & 0xFF), Double((value >> 8) & 0xFF), Double(value & 0xFF))
    }

    /// theme.ts mixHex와 동일: 채널별 round(a*(1-w) + b*w). (JS Math.round == 양수에서 half-up)
    static func mix(_ a: (r: Double, g: Double, b: Double), toward target: Double, weight w: Double) -> Color {
        func ch(_ v: Double) -> Double { (v * (1 - w) + target * w).rounded() / 255.0 }
        return Color(.sRGB, red: ch(a.r), green: ch(a.g), blue: ch(a.b), opacity: 1)
    }

    static func make(hex: String, isDark: Bool) -> LineTint {
        let c = rgb(fromHex: hex)
        let base = Color(.sRGB, red: c.r / 255.0, green: c.g / 255.0, blue: c.b / 255.0, opacity: 1)
        if isDark {
            return LineTint(
                base: base,
                lit: mix(c, toward: 255, weight: LineTintSpec.darkLitMix),
                text: mix(c, toward: 255, weight: LineTintSpec.darkTextMix),
                glow: base.opacity(LineTintSpec.darkGlowAlpha)
            )
        }
        return LineTint(
            base: base,
            lit: mix(c, toward: 0, weight: LineTintSpec.lightLitMix),
            text: mix(c, toward: 0, weight: LineTintSpec.lightTextMix),
            glow: base.opacity(LineTintSpec.lightGlowAlpha)
        )
    }
}
#endif
