import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostCard } from '../../src/components/PostCard';
import { StoriesRow } from '../../src/components/StoriesRow';
import { Wordmark } from '../../src/components/Wordmark';
import { makePosts, makeStories, type Post } from '../../src/content/fake';
import { pendingCount } from '../../src/direct';
import { useScreenActive } from '../../src/hooks';
import { useQuietMedia } from '../../src/power';
import { useChatSelector } from '../../src/session';
import { colors } from '../../src/theme';

const PAGE = 6;
const VIEWABILITY = { itemVisiblePercentThreshold: 60 } as const;

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // A number, not the whole state: the feed must not re-render on every streamed word of a chat.
  const pending = useChatSelector(pendingCount);
  const screenActive = useScreenActive();
  const quiet = useQuietMedia();
  const stories = useMemo(() => makeStories(), []);
  const [posts, setPosts] = useState<Post[]>(() => makePosts(0, PAGE));
  const [visibleVideo, setVisibleVideo] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onViewable = useRef(({ viewableItems }: { viewableItems: { item?: Post }[] }) => {
    const video = viewableItems.find((v) => v.item?.kind === 'video');
    setVisibleVideo(video?.item?.id ?? null);
  }).current;

  const loadMore = useCallback(() => setPosts((p) => [...p, ...makePosts(p.length, PAGE)]), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  // Hot phone, Low Power Mode or a call: posters instead of video.
  const activeId = screenActive && !quiet ? visibleVideo : null;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top, height: 48 + insets.top }]}>
        <Wordmark size={34} />
        <View style={styles.icons}>
          <Ionicons name="heart-outline" size={27} color={colors.text} />
          <Pressable onPress={() => router.push('/direct')} hitSlop={10} accessibilityLabel="Direct messages">
            <Ionicons name="paper-plane-outline" size={25} color={colors.text} />
            {pending > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{pending > 9 ? '9+' : pending}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>
      <FlatList
        data={posts}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => <PostCard post={item} active={item.id === activeId} />}
        ListHeaderComponent={<StoriesRow stories={stories} />}
        onEndReached={loadMore}
        onEndReachedThreshold={1.5}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={VIEWABILITY}
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={5}
        removeClippedSubviews
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.text} colors={[colors.text]} progressBackgroundColor={colors.surfaceHi} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, backgroundColor: colors.bg },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 22 },
  badge: { position: 'absolute', top: -7, right: -9, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: colors.like, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.bg },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
});
