require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'CellularTechListener'
  s.version        = package['version']
  s.summary        = 'CTRadioAccessTechnology listener for subway-now ADR-016 S10 environment consensus (#1543)'
  s.homepage       = 'https://github.com/handokei/subway-now'
  s.license        = 'MIT'
  s.author         = 'subway-now'
  s.platform       = :ios, '15.1'
  s.source         = { path: '.' }
  s.source_files   = 'ios/**/*.swift'
  s.frameworks     = 'CoreTelephony'
  s.dependency 'ExpoModulesCore'
end
