require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MotionActivity'
  s.version        = package['version']
  s.summary        = 'CMMotionActivity wrapper for subway-now static misfire guard (#728)'
  s.homepage       = 'https://github.com/handokei/subway-now'
  s.license        = 'MIT'
  s.author         = 'subway-now'
  s.platform       = :ios, '15.1'
  s.source         = { path: '.' }
  s.source_files   = 'ios/**/*.swift'
  s.frameworks     = 'CoreMotion'
  s.dependency 'ExpoModulesCore'
end
