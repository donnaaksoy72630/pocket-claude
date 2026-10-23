import { Ionicons } from '@expo/vector-icons';
import { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ReelItem } from '../../src/components/ReelItem';
import { makeReel, type Reel } from '../../src/content/fake';
import { useScreenActive } from '../../src/hooks';
import { useQuietMedia } from '../../src/power';
import { colors } from '../../src/theme';

const PAGE = 6;
const VIEWABILITY = { itemVisiblePercentThreshold: 80 } as const;

export default function ReelsScreen() {
  const insets = useSafeAreaInsets();
  const screenActive = useScreenActive();
  const quiet = useQuietMedia();
  const [height, setHeight] = useState(0);
  const [reels, setReels] = useState<Reel[]>(() => Array.from({ length: PAGE }, (_, i) => makeReel(i)));
  const [current, setCurrent] = useState<string | null>(null);

  const onViewable = useRef(({ viewableItems }: { viewableItems: { item?: Reel }[] }) => {
    const first = viewableItems[0];
    if (first?.item) setCurrent(first.item.id);
  }).current;

  const loadMore = useCallback(() => setReels((r) => [...r, ...Array.from({ length: PAGE }, (_, i) => makeReel(r.length + i))]), []);
  const onLayout = useCallback((e: LayoutChangeEvent) => setHeight(Math.round(e.nativeEvent.layout.height)), []);
  // Hot phone, Low Power Mode or a call: posters instead of video.
  const activeId = screenActive && !quiet ? (current ?? reels[0]?.id ?? null) : null;

  return (
    <View style={styles.root} onLayout={onLayout}>
      {height > 0 ? (
        <FlatList
          data={reels}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <ReelItem reel={item} height={height} active={item.id === activeId} />}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          pagingEnabled
          snapToInterval={height}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={VIEWABILITY}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          windowSize={3}
          removeClippedSubviews
        />
      ) : null}
      <View pointerEvents="none" style={[styles.top, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.title}>Reels</Text>
        <Ionicons name="camera-outline" size={28} color="#FFFFFF" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  title: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
});
