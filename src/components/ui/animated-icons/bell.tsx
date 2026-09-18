"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface BellIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface BellIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

// The bell rocks from its crown and settles, like it was just struck. The swing
// decays instead of looping so a hover reads as one ring, not an alarm.
const BELL_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.2, ease: "easeOut" } },
  animate: {
    rotate: [0, -12, 10, -8, 5, -2, 0],
    transition: { duration: 0.8, ease: "easeInOut" },
  },
};

// The clapper lags a beat behind the body, which is what makes the swing read
// as a bell rather than a tilting shape.
const CLAPPER_VARIANTS: Variants = {
  normal: { x: 0, transition: { duration: 0.2, ease: "easeOut" } },
  animate: {
    x: [0, 1.4, -1.2, 0.9, -0.5, 0],
    transition: { duration: 0.8, ease: "easeInOut", delay: 0.05 },
  },
};

const BellIcon = forwardRef<BellIconHandle, BellIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave]
    );

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <motion.svg
          animate={controls}
          fill="none"
          height={size}
          initial="normal"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          // Pivot at the crown, not the centre: a bell hangs from its top.
          style={{ transformOrigin: "50% 12%" }}
          variants={BELL_VARIANTS}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
          <motion.path d="M10.268 21a2 2 0 0 0 3.464 0" variants={CLAPPER_VARIANTS} />
        </motion.svg>
      </div>
    );
  }
);

BellIcon.displayName = "BellIcon";

export { BellIcon };
