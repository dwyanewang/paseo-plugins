import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { IMAGE_MAX_COUNT, validateWorkItemImages, type FieldError } from "../shared/limits";
import { describeImageError, imageDataUri, pickImageDrafts, subscribePastedImages, type DraftImage } from "./images";
import type { TodoStyles } from "./styles";

type ImageRefusal = Extract<FieldError, { field: "images" }>["reason"];

let nextTargetId = 0;

/** The images a Todo text box is holding before it is submitted. */
export interface DraftImages {
  images: DraftImage[];
  /** Put this on the box as `nativeID`: images pasted or dropped inside it land here. */
  targetId: string;
  picking: boolean;
  /** Files are being dragged over the box, so it can say they will attach. */
  dragging: boolean;
  full: boolean;
  pick: () => Promise<void>;
  remove: (id: string) => void;
  reset: (images: DraftImage[]) => void;
}

/**
 * Image drafts for one text box, starting from `initial`: the "+" chooser, paste and drop while
 * `active`, the count cap, and a toast for anything refused. Oversized images arrive already
 * scaled down by `client/web.ts`.
 */
export function useDraftImages(active: boolean, initial: DraftImage[] = []): DraftImages {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [images, setImages] = useState<DraftImage[]>(initial);
  // The chooser and paste resolve asynchronously; they add to what is there then, not at the start.
  const current = useRef<DraftImage[]>(initial);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pickingRef = useRef(false);
  const [targetId] = useState(() => `todo-image-drop-${++nextTargetId}`);

  const reset = useCallback((next: DraftImage[]) => {
    current.current = next;
    setImages(next);
  }, []);

  const add = useCallback(
    (picked: DraftImage[]) => {
      if (picked.length === 0) return;
      const next = [...current.current];
      let refused: ImageRefusal | null = null;
      for (const draft of picked) {
        if (next.length >= IMAGE_MAX_COUNT) {
          refused ??= "too_many";
          break;
        }
        const invalid = validateWorkItemImages([draft]);
        if (invalid?.field === "images") {
          refused ??= invalid.reason;
          continue;
        }
        next.push(draft);
      }
      if (refused) toastRef.current.error(describeImageError(refused));
      if (next.length !== current.current.length) reset(next);
    },
    [reset],
  );

  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = subscribePastedImages(targetId, add, setDragging);
    return () => {
      unsubscribe?.();
      setDragging(false);
    };
  }, [active, add, targetId]);

  const pick = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      const picked = await pickImageDrafts(Math.max(1, IMAGE_MAX_COUNT - current.current.length));
      if (picked === null) {
        toastRef.current.error("Adding images needs the desktop or web app.");
        return;
      }
      add(picked);
    } catch {
      toastRef.current.error("Could not open your photos. Allow Paseo to access them, then try again.");
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [add]);

  const remove = useCallback((id: string) => reset(current.current.filter((image) => image.id !== id)), [reset]);

  return { images, targetId, picking, dragging, full: images.length >= IMAGE_MAX_COUNT, pick, remove, reset };
}

/** Thumbnails of attached images; each carries a remove button when `onRemove` is given. */
export function ImageStrip(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  images: readonly DraftImage[];
  onRemove?: (id: string) => void;
  size?: number;
}) {
  const { theme } = props;
  const size = props.size ?? 56;
  if (props.images.length === 0) return null;
  return (
    <View style={[props.styles.rowWrap, { gap: 8, paddingTop: props.onRemove ? 6 : 0 }]}>
      {props.images.map((image) => (
        <View key={image.id} style={{ width: size, height: size }}>
          <Image
            source={{ uri: imageDataUri(image) }}
            style={{ width: size, height: size, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            accessibilityLabel={image.name ?? "Attached image"}
            resizeMode="cover"
          />
          {props.onRemove ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${image.name ?? "image"}`}
              hitSlop={6}
              onPress={() => props.onRemove?.(image.id)}
              style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
                position: "absolute",
                top: -6,
                right: -6,
                width: 18,
                height: 18,
                borderRadius: 9,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: hovered || pressed ? theme.colors.surface2 : theme.colors.surface1,
              })}
            >
              <Icon name="X" size={11} color={theme.colors.foreground} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
