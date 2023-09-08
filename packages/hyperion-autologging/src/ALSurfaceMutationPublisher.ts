/**
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

'use strict';

import type { Channel } from "@hyperion/hook/src/Channel";
import * as Types from "@hyperion/hyperion-util/src/Types";
import type { ALChannelSurfaceEvent, ALChannelSurfaceEventData } from './ALSurface';
import { ALLoggableEvent, ALMetadataEvent, ALOptionalFlowletEvent, ALReactElementEvent, ALSharedInitOptions } from "./ALType";

import { assert } from "@hyperion/global/src/assert";
import performanceAbsoluteNow from '@hyperion/hyperion-util/src/performanceAbsoluteNow';
import ALElementInfo from './ALElementInfo';
import * as ALEventIndex from './ALEventIndex';
import { ALFlowlet } from "./ALFlowletManager";
import * as ALID from './ALID';
import { ALElementTextEvent, getElementTextEvent } from './ALInteractableDOMElement';
import { ReactComponentData } from './ALReactUtils';

type ALMutationEvent = ALReactElementEvent & ALElementTextEvent & ALOptionalFlowletEvent & Readonly<
  {
    surface: string;
    element: HTMLElement;
    autoLoggingID: ALID.ALID;
  }
  &
  (
    {
      event: 'mount_component';
    }
    |
    {
      event: 'unmount_component';
      mountedDuration: number;
      mountEvent: ALSurfaceMutationEventData;
    }
  )
>;

export type ALSurfaceMutationEventData = Readonly<
  ALLoggableEvent &
  ALMutationEvent
>;

export type ALChannelSurfaceMutationEvent = Readonly<{
  al_surface_mutation_event: [ALSurfaceMutationEventData],
}
>;

export type ALSurfaceMutationChannel = Channel<ALChannelSurfaceMutationEvent & ALChannelSurfaceEvent>;

type SurfaceInfo = ALReactElementEvent & ALElementTextEvent & ALMetadataEvent & {
  surface: string,
  element: HTMLElement,
  addTime: number,
  removeTime?: number,
  flowlet: ALFlowlet,
  addFlowlet: ALFlowlet | null,
  removeFlowlet: ALFlowlet | null,
  mountEvent: ALSurfaceMutationEventData | null,
};

const activeSurfaces = new Map<string, SurfaceInfo>();

export type InitOptions = Types.Options<
  ALSharedInitOptions &
  {
    channel: ALSurfaceMutationChannel;
    cacheElementReactInfo: boolean;
  }
>;

export function publish(options: InitOptions): void {
  const { channel, flowletManager, cacheElementReactInfo } = options;

  function processNode(event: ALChannelSurfaceEventData, action: 'added' | 'removed') {
    const timestamp = performanceAbsoluteNow();
    const { element, surface, flowlet, metadata } = event;

    const currFlowlet = flowletManager.top();
    if (!(element instanceof HTMLElement) || /LINK|SCRIPT/.test(element.nodeName)) {
      return;
    }
    if (surface == null) {
      return;
    }
    switch (action) {
      case 'added': {
        let info = activeSurfaces.get(surface);
        if (!info) {
          let reactComponentData: ReactComponentData | null = null;
          let elementText: ALElementTextEvent;
          if (cacheElementReactInfo) {
            const elementInfo = ALElementInfo.getOrCreate(element);
            reactComponentData = elementInfo.getReactComponentData();
            elementText = getElementTextEvent(element, surface);
          } else {
            elementText = getElementTextEvent(null, surface);
          }
          info = {
            surface,
            element: element,
            addTime: timestamp,
            flowlet,
            addFlowlet: currFlowlet,
            reactComponentName: reactComponentData?.name,
            reactComponentStack: reactComponentData?.stack,
            ...elementText,
            removeFlowlet: null,
            mountEvent: null,
            metadata,
          };
          activeSurfaces.set(surface, info);
          emitMutationEvent(action, info);
        } else if (element != info.element && element.contains(info.element)) {
          /**
          * This means we are seeing a element that is higher in the DOM
          * and belongs to a surface that we have seen before.
          * So, we can just update the surface=>element info.
          *  */
          info.element = element;
          info.addFlowlet = currFlowlet;
          info.addTime = timestamp;
        }
        break;
      }
      case 'removed': {
        const info = activeSurfaces.get(surface);
        if (info && info.element === element) {
          info.removeFlowlet = currFlowlet;
          info.removeTime = timestamp;
          activeSurfaces.delete(surface);
          /**
           * We share the same object between the mount and unmount events
           * therefore, any change by the subscribers of these events will
           * be seen on the object itself.
           * If we really wanted to be sure we can run the following code
           * but the perf overhead would be un-necessary.
           * // Object.assign(info.metadata, metadata);
           */
          emitMutationEvent(action, info);
        }
        break;
      }
    }
  }

  channel.addListener('al_surface_mount', event => {
    processNode(event, 'added');
  });

  channel.addListener('al_surface_unmount', event => {
    processNode(event, 'removed');
  });


  function emitMutationEvent(
    action: 'added' | 'removed',
    surfaceInfo: SurfaceInfo
  ): void {
    const { removeTime, element, mountEvent } = surfaceInfo;
    switch (action) {
      case 'added': {
        const flowlet = surfaceInfo.addFlowlet;
        if (flowlet) {
          surfaceInfo.metadata.add_flowlet = flowlet.getFullName();
        }
        channel.emit('al_surface_mutation_event', surfaceInfo.mountEvent = {
          ...surfaceInfo,
          event: 'mount_component',
          eventTimestamp: surfaceInfo.addTime,
          eventIndex: ALEventIndex.getNextEventIndex(),
          autoLoggingID: ALID.getOrSetAutoLoggingID(element),
          // flowlet,
        });
        break;
      }
      case 'removed': {
        assert(mountEvent != null && removeTime != null, "Missing mutaion info for unmounting");
        const flowlet = surfaceInfo.removeFlowlet;
        if (flowlet) {
          surfaceInfo.metadata.remove_flowlet = flowlet.getFullName();
        }
        channel.emit('al_surface_mutation_event', {
          ...surfaceInfo,
          event: 'unmount_component',
          eventTimestamp: removeTime,
          eventIndex: ALEventIndex.getNextEventIndex(),
          autoLoggingID: ALID.getOrSetAutoLoggingID(element),
          mountedDuration: (removeTime - surfaceInfo.addTime) / 1000,
          // flowlet,
          mountEvent,
        });
        break;
      }
    }
  }
}
