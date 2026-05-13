// API Route Vercel pour sauvegarder config.json
// Utilise le système de fichiers si disponible (développement local)
// Pour la production, utilisez Vercel KV ou une base de données

const fs = require('fs');
const path = require('path');

export default async function handler(req, res) {
    // Vérifier que c'est une requête POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Valider les données
        const requiredKeys = ['restaurant', 'categories', 'products', 'admin'];
        if (!requiredKeys.every(key => key in req.body)) {
            return res.status(400).json({ error: 'Invalid configuration format' });
        }

        // Chemin vers config.json
        const configPath = path.join(process.cwd(), 'config.json');

        // Vérifier si on peut écrire (développement local uniquement)
        try {
            // Sauvegarder le fichier
            fs.writeFileSync(
                configPath,
                JSON.stringify(req.body, null, 2),
                'utf-8'
            );

            return res.status(200).json({
                success: true,
                persisted: true,
                message: 'Configuration sauvegardée avec succès'
            });
        } catch (writeError) {
            // En production (Vercel), l'écriture de fichier échoue; informer le client
            console.warn('Impossible d\'écrire le fichier (probablement en production Vercel):', writeError);
            return res.status(500).json({
                success: false,
                persisted: false,
                error: 'Impossible d\'écrire config.json sur le serveur',
                note: 'En production Vercel, utilisez Vercel KV ou une base de données pour la persistance'
            });
        }

    } catch (error) {
        console.error('Erreur lors de la sauvegarde:', error);
        return res.status(500).json({
            error: error.message || 'Erreur lors de la sauvegarde'
        });
    }
}

