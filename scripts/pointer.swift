// Moves the real macOS pointer. Reads lines "x y [ms]" (screen points, top-left origin) on stdin and glides there.
// "where" prints the current position. No event is posted: the pointer is warped, so no click or key can result.
import CoreGraphics
import Foundation
func pos() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine() {
  let p = line.split(separator: " ")
  if p.first == "where" { let c = pos(); print("\(Int(c.x)) \(Int(c.y))"); continue }
  guard p.count >= 2, let x = Double(p[0]), let y = Double(p[1]) else { continue }
  let ms = p.count > 2 ? (Double(p[2]) ?? 350) : 350
  let from = pos(); let steps = max(1, Int(ms / 8))
  for i in 1...steps {
    let t = Double(i) / Double(steps); let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2 // ease in-out
    CGWarpMouseCursorPosition(CGPoint(x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e))
    usleep(8000)
  }
  CGAssociateMouseAndMouseCursorPosition(1)
  print("ok \(Int(x)) \(Int(y))")
}
