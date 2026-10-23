import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useScreenActive } from '../hooks';
import type { Persona } from '../persona';
import { usePowerSaving } from '../power';
import { colors } from '../theme';
import { ClaudeAvatar } from './ClaudeAvatar';

function Dot({ delay, pulse }: { delay: number; pulse: boolean }) {
  const o = useSharedValue(0.35);
  useEffect(() => {
    if (!pulse) {
      o.value = 0.6;
      return;
    }
    o.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 380 }), withTiming(0.35, { duration: 380 })), -1));
    return () => cancelAnimation(o);
  }, [o, delay, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[styles.dot, style]} />;
}

export function TypingBubble({ persona }: { persona?: Persona }) {
  // An endless animation keeps the display busy every frame: only on screen, and not on a hot phone or in Low Power Mode.
  const pulse = useScreenActive() && !usePowerSaving();
  return (
    <View style={styles.row}>
      <ClaudeAvatar size={28} persona={persona} />
      <View style={styles.bubble}>
        <Dot delay={0} pulse={pulse} />
        <Dot delay={160} pulse={pulse} />
        <Dot delay={320} pulse={pulse} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingTop: 6 },
  bubble: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.bubble, borderRadius: 22, paddingHorizontal: 16, height: 40 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.textDim },
});
