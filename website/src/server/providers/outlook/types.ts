import { z } from "zod";

export const outlookFolderKinds = ["inbox", "sent_items"] as const;
export type OutlookFolderKind = (typeof outlookFolderKinds)[number];

const emailAddressSchema = z
  .object({
    name: z.string().nullish(),
    address: z.string().nullish()
  })
  .passthrough();

const recipientSchema = z
  .object({
    emailAddress: emailAddressSchema.nullish()
  })
  .passthrough();

export const graphMessageSchema = z
  .object({
    id: z.string().min(1),
    internetMessageId: z.string().nullish(),
    conversationId: z.string().nullish(),
    conversationIndex: z.string().nullish(),
    subject: z.string().nullish(),
    sender: recipientSchema.nullish(),
    from: recipientSchema.nullish(),
    toRecipients: z.array(recipientSchema).nullish(),
    ccRecipients: z.array(recipientSchema).nullish(),
    bccRecipients: z.array(recipientSchema).nullish(),
    receivedDateTime: z.string().nullish(),
    sentDateTime: z.string().nullish(),
    createdDateTime: z.string().nullish(),
    lastModifiedDateTime: z.string().nullish(),
    hasAttachments: z.boolean().nullish(),
    importance: z.string().nullish(),
    inferenceClassification: z.string().nullish(),
    isRead: z.boolean().nullish(),
    bodyPreview: z.string().nullish(),
    body: z.unknown().nullish(),
    uniqueBody: z.unknown().nullish(),
    webLink: z.string().nullish()
  })
  .passthrough();

export type GraphMessage = z.infer<typeof graphMessageSchema>;

export const graphRemovedMessageSchema = z
  .object({
    id: z.string().min(1),
    "@removed": z
      .object({
        reason: z.string().nullish()
      })
      .passthrough()
  })
  .passthrough();

export type GraphRemovedMessage = z.infer<typeof graphRemovedMessageSchema>;

export const graphDeltaPageSchema = z
  .object({
    value: z.array(z.union([graphRemovedMessageSchema, graphMessageSchema])),
    "@odata.nextLink": z.string().min(1).optional(),
    "@odata.deltaLink": z.string().min(1).optional()
  })
  .passthrough();

export type GraphDeltaPage = z.infer<typeof graphDeltaPageSchema>;

export function isRemovedMessage(
  item: GraphMessage | GraphRemovedMessage
): item is GraphRemovedMessage {
  return "@removed" in item;
}
