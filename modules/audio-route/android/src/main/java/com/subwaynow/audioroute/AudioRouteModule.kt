package com.subwaynow.audioroute

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AudioRouteModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("AudioRoute")

        Function("isHeadphonesConnected") {
            val audioManager = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                ?: return@Function false

            val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            val headphoneTypes = setOf(
                AudioDeviceInfo.TYPE_WIRED_HEADSET,
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                AudioDeviceInfo.TYPE_BLE_HEADSET,
            )
            devices.any { it.type in headphoneTypes }
        }
    }
}
