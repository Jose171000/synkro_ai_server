export interface Subcategory {
    id: string;
    name: string;
    requiredAttributes: string[];
}

export interface CategoryTree {
    [marketplace: string]: {
        name: string;
        subcategories: Subcategory[];
    }[];
}

export const MOCK_CATEGORY_TREE: CategoryTree = {
    amazon: [
        {
            name: 'Electronics',
            subcategories: [
                { id: 'elec_headphones', name: 'Headphones & Earbuds', requiredAttributes: ['Bluetooth_Version', 'Color', 'Battery_Life'] },
                { id: 'elec_smartphones', name: 'Smartphones', requiredAttributes: ['Operating_System', 'Storage_Capacity', 'Screen_Size'] },
            ],
        },
        {
            name: 'Clothing & Shoes',
            subcategories: [
                { id: 'shoes_athletic', name: 'Men´s Athletic Shoes', requiredAttributes: ['ShoeSize', 'OuterMaterialType', 'DepartmentName'] },
                { id: 'clothing_shirts', name: 'T-Shirts', requiredAttributes: ['Size', 'Color', 'Material'] },
            ],
        },
    ],
    mercadolibre: [
        {
            name: 'Electrónica, Audio y Video',
            subcategories: [
                { id: 'MLA1001', name: 'Auriculares', requiredAttributes: ['Formato_del_auricular', 'Con_Bluetooth', 'Es_inalambrico'] },
                { id: 'MLA1002', name: 'Celulares y Smartphones', requiredAttributes: ['Memoria_Interna', 'Memoria_RAM', 'Camara_Principal'] },
            ],
        },
        {
            name: 'Ropa y Accesorios',
            subcategories: [
                { id: 'MLA2001', name: 'Zapatillas', requiredAttributes: ['Material_del_interior', 'Genero', 'Estilo'] },
                { id: 'MLA2002', name: 'Remeras', requiredAttributes: ['Tipo_de_tela', 'Diseno_de_la_tela', 'Tipo_de_manga'] },
            ],
        },
    ],
};
