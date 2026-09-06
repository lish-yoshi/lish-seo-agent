import { clientHeaders } from './clientContext';

import { WPConfig, PostConfig, H2Section } from '../types';

// サーバーのAPIエンドポイント（環境変数から取得、デフォルトはローカル）
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// 認証ヘッダーを取得（ローカル開発用）
const getAuthHeaders = () => {
    const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;
    return apiKey ? { 'x-api-key': apiKey } : {};
};

// Function to upload an image to WordPress (サーバー経由)
export const uploadImage = async (
    wpConfig: WPConfig,
    base64Image: string,
    section: H2Section
): Promise<{ id: number; source_url: string }> => {
    const filename = `image-for-h2-${section.id}.jpg`;

    const response = await fetch(`${API_BASE_URL}/cms/upload-image`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
            ...clientHeaders()
        },
        body: JSON.stringify({
            base64Image,
            filename,
            title: section.h2Text,
            altText: section.altText
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to upload image' }));
        throw new Error(errorData.error || 'Unknown upload error');
    }

    const data = await response.json();
    return { id: data.id, source_url: data.source_url };
};

// Function to create a post in WordPress (サーバー経由)
export const createPost = async (
    wpConfig: WPConfig,
    postConfig: PostConfig,
    content: string
): Promise<{ link: string, id: number }> => {
    const postData: any = {
        title: postConfig.title,
        content,
        status: postConfig.status
    };

    // slugが指定されている場合は追加
    if (postConfig.slug) {
        postData.slug = postConfig.slug;
    }

    const response = await fetch(`${API_BASE_URL}/cms/create-post`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
            ...clientHeaders()
        },
        body: JSON.stringify(postData)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to create post' }));
        throw new Error(errorData.error || 'Unknown post creation error');
    }

    const data = await response.json();
    return { link: data.link, id: data.id };
};
