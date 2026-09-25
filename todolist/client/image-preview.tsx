import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, openImagePreview } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { imageDataUri, type DraftImage } from "./images";
import { Overlay, useInsets, useOverlay } from "./overlay";
import { subscribeArrowKeysWeb } from "./web";

/** The host's zoomable viewer; undefined on hosts that predate it, which get `ImagePreview`. */
const hostPreview = typeof openImagePreview === "function" ? openImagePreview : null;

/** Whether thumbnails open the host's viewer, so no `ImagePreview` needs to be mounted. */
export const HOST_IMAGE_PREVIEW = hostPreview !== null;

/** Opens `images` at `index` in the host's viewer; false where there is none. */
export function openHostImagePreview(images: readonly DraftImage[], index: number): boolean {
  if (!hostPreview || images.length === 0) return false;
  hostPreview({ images: images.map((image) => ({ uri: imageDataUri(image), ...(image.name ? { name: image.name } : {}) })), index });
  return true;
}

/**
 * One attached image at a time over the darkened window, as large as fits and never scaled up,
 * with its name, its place among the others, and buttons (or the arrow keys) to page through them.
 * A press outside the image closes it. Keep it mounted and set `index` to open it.
 */
export function ImagePreview(props: { theme: PluginTheme; images: readonly DraftImage[]; index: number | null; onIndex: (index: number | null) => void }) {
  const open = props.index !== null && props.images.length > 0;
  return (
    <Overlay theme={props.theme} open={open} onClose={() => props.onIndex(null)} variant="box" accessibilityLabel="Image preview">
      {open ? <PreviewBody images={props.images} index={Math.min(props.index ?? 0, props.images.length - 1)} onIndex={props.onIndex} /> : null}
    </Overlay>
  );
}

/** The row above the image: its name and the buttons. */
const BAR_HEIGHT = 36;
const WHITE = "#ffffff";

type Size = { width: number; height: number };

function PreviewBody(props: { images: readonly DraftImage[]; index: number; onIndex: (index: number | null) => void }) {
  const { root, phone, close } = useOverlay();
  const insets = useInsets();
  const count = props.images.length;
  const image = props.images[props.index]!;
  const uri = imageDataUri(image);
  // Null while the size is read; "unknown" when it cannot be, and the image just fits the space.
  const [natural, setNatural] = useState<Size | "unknown" | null>(null);
  useEffect(() => {
    let live = true;
    setNatural(null);
    Image.getSize(
      uri,
      (width, height) => live && setNatural(width > 0 && height > 0 ? { width, height } : "unknown"),
      () => live && setNatural("unknown"),
    );
    return () => {
      live = false;
    };
  }, [uri]);

  const step = (direction: -1 | 1) => props.onIndex((props.index + direction + count) % count);
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (count < 2) return undefined;
    return (
      subscribeArrowKeysWeb((direction) => {
        stepRef.current(direction);
        return true;
      }) ?? undefined
    );
  }, [count]);

  const margin = phone ? 12 : 40;
  const barTop = insets.top + (phone ? 8 : 20);
  const top = barTop + BAR_HEIGHT + (phone ? 8 : 12);
  const space = {
    width: Math.max(1, root.width - margin * 2 - insets.left - insets.right),
    height: Math.max(1, root.height - top - margin - insets.bottom),
  };
  const shown: Size | null =
    natural === null
      ? null
      : natural === "unknown"
        ? space
        : (() => {
            const scale = Math.min(1, space.width / natural.width, space.height / natural.height);
            return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
          })();

  return (
    <>
      <Pressable accessibilityLabel="Close preview" focusable={false} onPress={close} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0, 0, 0, 0.86)" }]} />
      <View pointerEvents="box-none" style={{ position: "absolute", top, left: margin + insets.left, width: space.width, height: space.height, alignItems: "center", justifyContent: "center" }}>
        {shown ? <Image source={{ uri }} style={shown} resizeMode="contain" accessibilityLabel={image.name ?? "Attached image"} /> : null}
      </View>
      <View pointerEvents="box-none" style={{ position: "absolute", top: barTop, left: margin + insets.left, right: margin + insets.right, height: BAR_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: WHITE, fontSize: 13.5, opacity: 0.9 }} numberOfLines={1}>
          {[image.name, count > 1 ? `${props.index + 1} / ${count}` : null].filter(Boolean).join("  ·  ")}
        </Text>
        {count > 1 ? (
          <>
            <BarButton icon="ChevronLeft" label="Previous image" onPress={() => step(-1)} />
            <BarButton icon="ChevronRight" label="Next image" onPress={() => step(1)} />
          </>
        ) : null}
        <BarButton icon="X" label="Close preview" onPress={close} />
      </View>
    </>
  );
}

function BarButton(props: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
        width: BAR_HEIGHT,
        height: BAR_HEIGHT,
        borderRadius: BAR_HEIGHT / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? "rgba(255, 255, 255, 0.28)" : hovered ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.12)",
      })}
    >
      <Icon name={props.icon} size={18} color={WHITE} />
    </Pressable>
  );
}
