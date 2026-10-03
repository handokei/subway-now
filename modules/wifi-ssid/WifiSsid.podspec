require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'WifiSsid'
  s.version        = package['version']
  s.summary        = 'Current wifi SSID bridge for subway-now F2 underground station lookup (#913)'
  s.homepage       = 'https://github.com/handokei/subway-now'
  s.license        = 'MIT'
  s.author         = 'subway-now'
  s.platform       = :ios, '15.1'
  s.source         = { path: '.' }
  s.source_files   = 'ios/**/*.swift'
  s.frameworks     = 'NetworkExtension', 'SystemConfiguration', 'CoreLocation'
  s.dependency 'ExpoModulesCore'
end
