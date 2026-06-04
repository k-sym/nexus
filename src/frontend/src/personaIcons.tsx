import {
  Wrench, Code, MagnifyingGlass, Compass, PaintBrush,
  Brain, Lightning, Robot, Detective, Sparkle, type Icon,
} from '@phosphor-icons/react';
import { DEFAULT_PERSONA_COLOR, PERSONA_ICON_NAMES, type PersonaIconName } from '@nexus/shared';

const ICONS: Record<PersonaIconName, Icon> = {
  Wrench, Code, MagnifyingGlass, Compass, PaintBrush,
  Brain, Lightning, Robot, Detective, Sparkle,
};

/** The curated choices, for the persona editor picker. */
export const PERSONA_ICON_CHOICES = PERSONA_ICON_NAMES.map(name => ({ name, Icon: ICONS[name] }));

/** Render a persona's icon in its accent colour; falls back to Robot/zinc when unset/unknown. */
export function PersonaIcon({ icon, color, size = 16 }: { icon?: string; color?: string; size?: number }) {
  const Cmp = (icon && ICONS[icon as PersonaIconName]) || Robot;
  return <Cmp size={size} weight="fill" color={color || DEFAULT_PERSONA_COLOR} />;
}
