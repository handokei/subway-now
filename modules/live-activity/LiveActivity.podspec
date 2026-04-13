require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'LiveActivity'
  s.version        = package['version']
  s.summary        = 'Live Activity native module for subway-now'
  s.homepage       = 'https://github.com/handokei/subway-now'
  s.license        = 'MIT'
  s.author         = 'subway-now'
  s.platform       = :ios, '15.1'
  s.source         = { path: '.' }
  s.source_files   = 'ios/**/*.swift'
  s.dependency 'ExpoModulesCore'
end
