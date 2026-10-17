require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AccelerometerFingerprint'
  s.version        = package['version']
  s.summary        = 'CMMotionManager raw accelerometer fingerprint for subway-now lockless BG underground (#1542)'
  s.homepage       = 'https://github.com/handokei/subway-now'
  s.license        = 'MIT'
  s.author         = 'subway-now'
  s.platform       = :ios, '15.1'
  s.source         = { path: '.' }
  s.source_files   = 'ios/**/*.swift'
  s.frameworks     = 'CoreMotion'
  s.dependency 'ExpoModulesCore'
end
